# SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
#
# SPDX-License-Identifier: MPL-2.0

from arduino.app_utils import App, Bridge, Logger
from arduino.app_bricks.web_ui import WebUI
from arduino.app_bricks.motion_detection import MotionDetection
import pandas as pd
import json
import os
import time


CONFIDENCE = 0.4
STEER_THRESHOLD_DEG = 8.0
MCU_STATE_PUSH_PERIOD_S = 0.35
BUTTON_B_RESET_DEBOUNCE_S = 0.8
GRAVITY_MPS2 = 9.81

motion_detection = MotionDetection(confidence=CONFIDENCE)

logger = Logger("f1-wheel")

# Last classification probabilities from the Edge model.
detection_df = pd.DataFrame(
    {
        'idle': [0.0],
        'steering': [0.0],
        'gearchange': [0.0],
    }
)

# Current dominant motion state used for MCU hints.
current_motion_state = "idle"

# Engine/button state is still mirrored for the web UI, but the MCU now owns
# rev/gear/redline timing and matrix animation clocks.
engine_on      = False
button_c_held  = False
_prev_motion_state = "idle"
current_angle_deg = 0.0
current_steer_dir = 0
_last_mcu_state = "idle"
_last_mcu_steer_dir = 0
_last_mcu_push_ts = 0.0
pixels_connected = False
current_gear = 1
_last_button_b_reset_ts = 0.0

web_ui = WebUI()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _notify_bridge(method: str, *args, warn: bool = False):
    try:
        Bridge.notify(method, *args)
        return True
    except Exception as e:
        if warn:
            logger.warning(f"Bridge notify failed for {method}: {e}")
        return False


def _send_ui(message: str, payload: dict):
    try:
        web_ui.send_message(message, payload)
        return True
    except Exception:
        return False


def _provide_bridge(name: str, handler):
    try:
        Bridge.provide(name, handler)
    except RuntimeError:
        pass


runtime_config = {
    "angle_offset_deg": max(-180.0, min(180.0, _env_float("F1_WHEEL_ANGLE_OFFSET_DEG", 21.0))),
    "angle_invert": _env_bool("F1_WHEEL_ANGLE_INVERT", True),
}
RUNTIME_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "runtime_config.json")


def _save_runtime_config():
    try:
        with open(RUNTIME_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(runtime_config, f)
    except Exception as e:
        logger.warning(f"Failed to save runtime config: {e}")


def _load_runtime_config():
    if not os.path.exists(RUNTIME_CONFIG_PATH):
        return
    try:
        with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            if "angle_offset_deg" in data:
                runtime_config["angle_offset_deg"] = _clamp_angle_offset(float(data["angle_offset_deg"]))
            if "angle_invert" in data and isinstance(data["angle_invert"], bool):
                runtime_config["angle_invert"] = data["angle_invert"]
            logger.info(
                f"Loaded persisted calibration: offset={runtime_config['angle_offset_deg']:.1f}, "
                f"invert={runtime_config['angle_invert']}"
            )
    except Exception as e:
        logger.warning(f"Failed to load runtime config: {e}")

def _get_detection():
    return detection_df.to_dict(orient='records')[0]


def _get_config():
    out = dict(runtime_config)
    out["pixels_connected"] = pixels_connected
    out["engine_on"] = engine_on
    out["button_c_held"] = button_c_held
    out["gear"] = current_gear
    return out


def _clamp_angle_offset(value: float) -> float:
    return max(-180.0, min(180.0, value))


def on_angle_calibration(_sid, payload):
    if not isinstance(payload, dict):
        return

    updated = False

    if "offsetDeg" in payload:
        try:
            runtime_config["angle_offset_deg"] = _clamp_angle_offset(float(payload["offsetDeg"]))
            updated = True
        except (TypeError, ValueError):
            pass

    if "invert" in payload and isinstance(payload["invert"], bool):
        runtime_config["angle_invert"] = payload["invert"]
        updated = True

    if updated:
        _save_runtime_config()
        logger.info(
            f"Updated angle calibration: offset={runtime_config['angle_offset_deg']:.1f}, "
            f"invert={runtime_config['angle_invert']}"
        )
        _broadcast_calibration()


def _broadcast_calibration():
    _send_ui(
        'angle_calibration_state',
        {
            'offsetDeg': float(runtime_config.get('angle_offset_deg', 0.0)),
            'invert': bool(runtime_config.get('angle_invert', True)),
        },
    )


_load_runtime_config()


web_ui.expose_api("GET", "/detection", _get_detection)
web_ui.expose_api("GET", "/config", _get_config)
web_ui.on_message("angle_calibration", on_angle_calibration)


def on_ui_button_a_press(_sid, _payload):
    _notify_bridge("ui_button_a_press", warn=True)


def on_ui_button_b_press(_sid, _payload):
    _notify_bridge("ui_button_b_press", warn=True)


def on_ui_button_c_set(_sid, payload):
    held = 0
    if isinstance(payload, dict):
        held = 1 if bool(payload.get("held", False)) else 0
    _notify_bridge("ui_button_c_set", held, warn=True)


web_ui.on_message("ui_button_a_press", on_ui_button_a_press)
web_ui.on_message("ui_button_b_press", on_ui_button_b_press)
web_ui.on_message("ui_button_c_set", on_ui_button_c_set)

web_ui.on_connect(
    lambda _sid: (
        _send_ui('movement', detection_df.to_dict(orient='records')[0]),
        _send_ui('pixels_connected_state', {'connected': pixels_connected}),
        _send_ui('engine_toggle', {'on': engine_on}),
        _send_ui('button_c_state', {'held': button_c_held}),
        _send_ui('button_b_downshift', {'gear': current_gear}),
        _broadcast_calibration(),
    )
)


def on_movement_detected(classification: dict):
    if not classification:
        return

    try:
        global detection_df, current_motion_state, _prev_motion_state
        # Model returns 0–100; normalise to 0–1 to match CONFIDENCE threshold and UI multiplier
        detection_df = pd.DataFrame(
            {
                'idle': [classification.get('idle', 0.0) / 100.0],
                'steering': [classification.get('steering', 0.0) / 100.0],
                'gearchange': [classification.get('gearchange', 0.0) / 100.0],
            }
        )

        # Update LED state: dominant class wins if above confidence threshold
        dominant = max(detection_df.columns, key=lambda k: detection_df[k].iloc[0])
        current_motion_state = dominant if detection_df[dominant].iloc[0] >= CONFIDENCE else "idle"
        logger.debug(f"State: {current_motion_state} (conf={detection_df[dominant].iloc[0]:.2f})")

        # Leading-edge gear-up: notify MCU once; the MCU owns gear timing/display.
        if current_motion_state == 'gearchange' and _prev_motion_state != 'gearchange':
            _notify_bridge("ml_gear_up")

        _push_mcu_motion_state(force=True)
        _prev_motion_state = current_motion_state

        if not _send_ui('movement', detection_df.to_dict(orient='records')[0]):
            logger.warning("Failed to broadcast 'movement' message")

    except Exception as e:
        logger.exception(f"on_movement_detected: Error: {e}")


motion_detection.on_movement_detection('idle', on_movement_detected)
motion_detection.on_movement_detection('steering', on_movement_detected)
motion_detection.on_movement_detection('gearchange', on_movement_detected)


def record_sensor_movement(x: float, y: float, z: float):
    try:
        global current_angle_deg, current_steer_dir
        motion_detection.accumulate_samples((x * GRAVITY_MPS2, y * GRAVITY_MPS2, z * GRAVITY_MPS2))

        clamped_x = max(-1.0, min(1.0, float(x)))
        signed_x = -clamped_x if runtime_config.get("angle_invert", True) else clamped_x
        current_angle_deg = (signed_x * 90.0) + float(runtime_config.get("angle_offset_deg", 0.0))
        if current_angle_deg < -STEER_THRESHOLD_DEG:
            current_steer_dir = -1
        elif current_angle_deg > STEER_THRESHOLD_DEG:
            current_steer_dir = 1
        else:
            current_steer_dir = 0

        _push_mcu_motion_state()

        sample = {"t": time.time(), "x": float(x), "y": float(y), "z": float(z)}
        _send_ui('sample', sample)

    except Exception as e:
        logger.exception(f"record_sensor_movement: Error: {e}")


def _push_mcu_motion_state(force: bool = False):
    global _last_mcu_state, _last_mcu_steer_dir, _last_mcu_push_ts
    now = time.time()
    motion_state = "steering" if current_motion_state == "steering" else "idle"

    changed = (motion_state != _last_mcu_state) or (current_steer_dir != _last_mcu_steer_dir)
    periodic = (now - _last_mcu_push_ts) > MCU_STATE_PUSH_PERIOD_S
    if not (force or changed or periodic):
        return

    if _notify_bridge("ml_state_update", motion_state, int(current_steer_dir)):
        _last_mcu_state = motion_state
        _last_mcu_steer_dir = int(current_steer_dir)
        _last_mcu_push_ts = now


_provide_bridge("record_sensor_movement", record_sensor_movement)

def button_a_press():
    global engine_on
    engine_on = not engine_on
    _send_ui('engine_toggle', {'on': engine_on})


def button_c_state(held: int):
    global button_c_held
    button_c_held = bool(held)
    _send_ui('button_c_state', {'held': button_c_held})


def button_b_downshift(gear: int):
    global current_gear
    try:
        g = int(gear)
    except (TypeError, ValueError):
        g = 1
    g = max(1, min(6, g))
    current_gear = g
    _send_ui('button_b_downshift', {'gear': g})


def pixels_connected_state(connected: int):
    global pixels_connected
    pixels_connected = bool(connected)
    _send_ui('pixels_connected_state', {'connected': pixels_connected})


def button_b_reset_level():
    global _last_button_b_reset_ts
    now = time.time()
    # Ignore rapid duplicate reset requests while still acknowledging them.
    if (now - _last_button_b_reset_ts) >= BUTTON_B_RESET_DEBOUNCE_S:
        runtime_config['angle_offset_deg'] = _clamp_angle_offset(
            float(runtime_config.get('angle_offset_deg', 0.0)) - float(current_angle_deg)
        )
        _save_runtime_config()
        _broadcast_calibration()
        _last_button_b_reset_ts = now
        logger.info(
            f"B hold reset applied: offset={runtime_config['angle_offset_deg']:.1f}, "
            f"current_angle={current_angle_deg:.1f}"
        )

    _notify_bridge('button_b_reset_ack')


def wheel_state_sync(engine: int, accel_held: int, gear: int, reset_pending: int = 0):
    global engine_on, button_c_held, current_gear

    engine_on = bool(engine)
    button_c_held = bool(accel_held)

    try:
        g = int(gear)
    except (TypeError, ValueError):
        g = 1
    current_gear = max(1, min(6, g))

    _send_ui('engine_toggle', {'on': engine_on})
    _send_ui('button_c_state', {'held': button_c_held})
    _send_ui('button_b_downshift', {'gear': current_gear})

    if bool(reset_pending):
        button_b_reset_level()


_provide_bridge("button_a_press", button_a_press)
_provide_bridge("button_c_state", button_c_state)
_provide_bridge("button_b_downshift", button_b_downshift)
_provide_bridge("pixels_connected_state", pixels_connected_state)
_provide_bridge("button_b_reset_level", button_b_reset_level)
_provide_bridge("wheel_state_sync", wheel_state_sync)
logger.info("Starting App...")
App.run()
