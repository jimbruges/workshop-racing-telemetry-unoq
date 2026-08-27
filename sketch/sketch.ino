// SPDX-FileCopyrightText: Copyright (C) Arduino s.r.l. and/or its affiliated companies
//
// SPDX-License-Identifier: MPL-2.0

#include <Arduino_Modulino.h>
#include <Arduino_RouterBridge.h>
#include <Arduino_LED_Matrix.h>
#include <string.h>

ModulinoMovement movement;
ModulinoButtons  buttons;
ModulinoPixels   pixels;
Arduino_LED_Matrix matrix;

float x_accel = 0, y_accel = 0, z_accel = 0;

unsigned long previousSensorMillis = 0;
const long sensorInterval = 16;
int has_movement = 0;

unsigned long previousBtnMillis = 0;
const long btnInterval = 50;            // 20 Hz button polling
bool prevA = false, prevC = false;
bool prevB = false;
bool engineIsOn = false;               // local mirror for A-button LED
bool remoteCHeld = false;
unsigned long remoteBPulseUntil = 0;
bool bPressActive = false;
bool bHoldActionSent = false;
bool bResetRequestPending = false;
unsigned long bPressStartMillis = 0;
const unsigned long B_HOLD_RESET_MS = 900;

unsigned long previousLedMillis = 0;
const long ledInterval = 33;          // ~30 Hz matrix updates for smoother on-device animation
unsigned long previousStateSyncMillis = 0;
const unsigned long STATE_SYNC_MS = 500;

String currentState = "idle";
int  currentGear    = 1;
bool atRedline      = false;
float rpmPct        = 0.0f;
unsigned long gearChangeTime = 0;
const unsigned long GEAR_DISPLAY_MS = 1500;
unsigned long previousRpmMillis = 0;
unsigned long lastMpuStateMillis = 0;
const unsigned long MPU_STATE_TIMEOUT_MS = 1200;

const float RPM_ACCEL_BY_GEAR[7] = {0.0f, 0.70f, 0.30f, 0.22f, 0.17f, 0.13f, 0.065f};
const float RPM_DECEL = 0.30f;
const float RPM_ENGINE_OFF_DECEL = 0.30f;
const int REV_SEGMENTS = 8;
const long CAR_SCROLL_INTERVAL_MS_BY_GEAR[7] = {0, 260, 210, 170, 130, 90, 60};
bool pixelsConnected = false;
unsigned long previousPixelsStateBroadcastMillis = 0;
const unsigned long PIXELS_STATE_BROADCAST_MS = 1500;

bool arrowFlash  = true;
unsigned long arrowFlashTime = 0;
int revBarLit = 0;
int steerDir = 0;

// Racecar idle animation state
int carX = 0;
int carTick = 0;
unsigned long previousCarAnimMillis = 0;
unsigned long previousCarMoveMillis = 0;

static const uint8_t ROWS = 8;
static const uint8_t COLS = 13;
static const uint8_t SPR_W = 13;
static const uint8_t SPR_H = 8;
static const int EXHAUST_PUFFS = 4;
static const int EXHAUST_SPACING_X = 3;
static const int EXHAUST_BACK_X = 2;
static const int EXHAUST_Y = 5;
static const int EXHAUST_TRAIL_X = EXHAUST_BACK_X + (EXHAUST_PUFFS - 1) * EXHAUST_SPACING_X;

uint8_t frame_car_anim[104];

static const uint8_t CAR_SPRITE[SPR_W * SPR_H] = {
    0,0,0,0,7,7,7,7,0,0,0,0,0,
    0,0,0,7,0,5,0,0,7,0,0,0,0,
    0,0,7,0,0,5,0,0,0,7,0,0,0,
    0,7,7,5,5,5,5,5,5,7,7,6,0,
    7,7,5,5,5,5,5,5,5,5,7,7,7,
    7,7,5,0,0,7,7,7,0,0,5,7,7,
    0,0,7,3,7,0,0,0,7,3,7,0,0,
    0,0,0,7,0,0,0,0,0,7,0,0,0,
};

// ── LED matrix frames (8 rows × 13 cols = 104 pixels, grayscale 0–7) ──

// Steering left: chevrons <<
uint8_t frame_steer_left[104] = {
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,7,0,0,7,0,0,7,0,0,0,0,
    0,7,0,0,7,0,0,7,0,0,0,0,0,
    0,7,0,0,7,0,0,7,0,0,0,0,0,
    0,0,7,0,0,7,0,0,7,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
};

// Steering right: chevrons >>
uint8_t frame_steer_right[104] = {
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,7,0,0,7,0,0,7,0,0,
    0,0,0,0,0,7,0,0,7,0,0,7,0,
    0,0,0,0,0,7,0,0,7,0,0,7,0,
    0,0,0,0,7,0,0,7,0,0,7,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
};

// Engine-off: very dim idle outline (brightness 1)
uint8_t frame_engine_off[104] = {
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,1,1,1,1,1,0,0,0,0,
    0,0,0,1,0,0,0,0,0,1,0,0,0,
    0,0,0,1,0,0,0,0,0,1,0,0,0,
    0,0,0,1,0,0,0,0,0,1,0,0,0,
    0,0,0,1,0,0,0,0,0,1,0,0,0,
    0,0,0,0,1,1,1,1,1,0,0,0,0,
    0,0,0,0,0,0,1,0,0,0,0,0,0
};

// 7-segment gear digits (cols 3-9, rows 0-6, row 7 blank, 2-px-wide verticals)
uint8_t frame_gears[6][104] = {
  /* Gear 1 — centred shaft with flag */
  {
    0,0,0,0,0,7,0,0,0,0,0,0,0,
    0,0,0,0,7,7,0,0,0,0,0,0,0,
    0,0,0,0,0,7,0,0,0,0,0,0,0,
    0,0,0,0,0,7,0,0,0,0,0,0,0,
    0,0,0,0,0,7,0,0,0,0,0,0,0,
    0,0,0,0,0,7,0,0,0,0,0,0,0,
    0,0,0,7,7,7,7,7,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
  },
  /* Gear 2 */
  {
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,7,7,0,0,0,0,0,0,0,0,
    0,0,0,7,7,0,0,0,0,0,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
  },
  /* Gear 3 */
  {
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
  },
  /* Gear 4 */
  {
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,7,7,0,0,0,7,7,0,0,0,
    0,0,0,7,7,0,0,0,7,7,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
  },
  /* Gear 5 */
  {
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,7,7,0,0,0,0,0,0,0,0,
    0,0,0,7,7,0,0,0,0,0,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,0,0,0,0,0,7,7,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
  },
  /* Gear 6 */
  {
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,7,7,0,0,0,0,0,0,0,0,
    0,0,0,7,7,0,0,0,0,0,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,7,7,0,0,0,7,7,0,0,0,
    0,0,0,7,7,0,0,0,7,7,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,0,0,0,0,0,0,0
  },
};

// Upshift arrow (centred on col 6)
uint8_t frame_shift_arrow[104] = {
    0,0,0,0,0,0,7,0,0,0,0,0,0,
    0,0,0,0,0,7,7,7,0,0,0,0,0,
    0,0,0,0,7,7,7,7,7,0,0,0,0,
    0,0,0,7,7,7,7,7,7,7,0,0,0,
    0,0,0,0,0,0,7,0,0,0,0,0,0,
    0,0,0,0,0,0,7,0,0,0,0,0,0,
    0,0,0,0,0,0,7,0,0,0,0,0,0,
    0,0,0,0,0,0,7,0,0,0,0,0,0
};

void draw_with_revbar(const uint8_t* baseFrame, int litCount) {
    uint8_t composed[104];
    memcpy(composed, baseFrame, sizeof(composed));

    if (!pixelsConnected) {
        // Additive top-row bar with 8 logical segments mapped across 13 columns.
        int clamped = constrain(litCount, 0, REV_SEGMENTS);
        for (int seg = 0; seg < REV_SEGMENTS; seg++) {
            if (seg >= clamped) continue;

            int level = 2 + ((seg * 5) / (REV_SEGMENTS - 1)); // 2..7 across segments
            uint8_t boosted = (uint8_t)constrain(level, 0, 7);
            int start = (seg * 13) / REV_SEGMENTS;
            int endExclusive = ((seg + 1) * 13) / REV_SEGMENTS;
            for (int col = start; col < endExclusive; col++) {
                if (boosted > composed[col]) composed[col] = boosted;
            }
        }
    }

    matrix.draw(composed);
}

void update_pixels_revs(bool engineOnState, int litCount, bool redlineFlashOn) {
    if (!pixelsConnected) {
        return;
    }

    if (!engineOnState) {
        pixels.clear();
        pixels.show();
        return;
    }

    int clamped = constrain(litCount, 0, REV_SEGMENTS);
    for (int i = 0; i < REV_SEGMENTS; i++) {
        if (atRedline) {
            if (redlineFlashOn) {
                pixels.set(i, RED, 70);
            } else {
                pixels.clear(i);
            }
            continue;
        }

        if (i >= clamped) {
            pixels.clear(i);
            continue;
        }

        if (i < 3) {
            pixels.set(i, GREEN, 50);
        } else if (i < 6) {
            pixels.set(i, YELLOW, 60);
        } else {
            pixels.set(i, RED, 70);
        }
    }
    pixels.show();
}

void dim_frame(uint8_t *buf, uint8_t maxLevel) {
    for (int i = 0; i < 104; i++) {
        if (buf[i] == 0) continue;
        if (buf[i] > maxLevel) buf[i] = maxLevel;
    }
}

void on_ml_state_update(String motionState, int steerHint) {
    if (motionState == "steering") currentState = "steering";
    else currentState = "idle";
    steerDir = constrain(steerHint, -1, 1);
    lastMpuStateMillis = millis();
}

void on_ml_gear_up() {
    if (currentGear >= 6) {
        return;
    }
    currentGear++;
    gearChangeTime = millis();
    if (engineIsOn) rpmPct = 0.40f;
}

void on_button_b_reset_ack() {
    bResetRequestPending = false;
}

void on_ui_button_a_press() {
    engineIsOn = !engineIsOn;
    Bridge.notify("button_a_press");
}

void on_ui_button_b_press() {
    remoteBPulseUntil = millis() + 180;
    if (currentGear > 1) {
        currentGear--;
        if (engineIsOn) {
            rpmPct = max(rpmPct, 0.55f);
        }
        Bridge.notify("button_b_downshift", currentGear);
    }
}

void on_ui_button_c_set(int held) {
    remoteCHeld = (held != 0);
}

void update_rpm_state(unsigned long now) {
    if (previousRpmMillis == 0) {
        previousRpmMillis = now;
        return;
    }
    float dt = (float)(now - previousRpmMillis) / 1000.0f;
    if (dt > 0.10f) dt = 0.10f;
    previousRpmMillis = now;

    if (!engineIsOn) {
        rpmPct -= RPM_ENGINE_OFF_DECEL * dt;
        if (rpmPct < 0.0f) rpmPct = 0.0f;
        revBarLit = 0;
        atRedline = false;
        return;
    }

    if (prevC) {
        float accel = RPM_ACCEL_BY_GEAR[constrain(currentGear, 1, 6)];
        rpmPct += accel * dt;
        if (rpmPct > 1.0f) rpmPct = 1.0f;
    } else {
        rpmPct -= RPM_DECEL * dt;
        if (rpmPct < 0.0f) rpmPct = 0.0f;
        if (rpmPct < 0.15f && currentGear > 1) {
            currentGear--;
            rpmPct = 0.55f;
        }
    }

    atRedline = rpmPct >= 0.92f;
    revBarLit = constrain((int)roundf(rpmPct * (float)REV_SEGMENTS), 0, REV_SEGMENTS);
}

void clear_anim_frame(uint8_t *buf) {
    memset(buf, 0, ROWS * COLS);
}

void set_anim_pixel(uint8_t *buf, int x, int y, uint8_t value = 7) {
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return;
    if (value > 7) value = 7;
    buf[y * COLS + x] = value;
}

void draw_anim_sprite(uint8_t *buf, const uint8_t *sprite, int w, int h, int x0, int y0) {
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            uint8_t v = sprite[y * w + x];
            if (v) set_anim_pixel(buf, x0 + x, y0 + y, v);
        }
    }
}

void draw_racecar(uint8_t *buf, int tailX, int topY, int tick, bool animate) {
    draw_anim_sprite(buf, CAR_SPRITE, SPR_W, SPR_H, tailX, topY);

    uint8_t hub = (animate && (tick & 1)) ? 3 : 0;
    set_anim_pixel(buf, tailX + 3, topY + 6, hub);
    set_anim_pixel(buf, tailX + 9, topY + 6, hub);
    set_anim_pixel(buf, tailX + 12, topY + 4, animate ? ((tick & 1) ? 7 : 5) : 2);
}

void draw_exhaust(uint8_t *buf, int tailX, int topY, int phase) {
    int puffX = tailX - EXHAUST_BACK_X;
    int puffY = topY + EXHAUST_Y;
    int p = phase % 4;

    uint8_t baseB = 6;
    if (p == 0) baseB = 5;
    else if (p == 1) baseB = 6;
    else if (p == 2) baseB = 7;
    else baseB = 4;

    for (int i = 0; i < EXHAUST_PUFFS; i++) {
        int x = puffX - (i * EXHAUST_SPACING_X);
        int falloff = i * 2;

        auto level = [&](uint8_t v) -> uint8_t {
            int out = (int)v - falloff;
            if (out < 1) out = 1;
            if (out > 7) out = 7;
            return (uint8_t)out;
        };

        auto bright = [&](int delta) -> uint8_t {
            int b = (int)baseB - delta;
            if (b < 1) b = 1;
            if (b > 7) b = 7;
            return (uint8_t)b;
        };

        auto pix = [&](int dx, int dy, uint8_t v) {
            set_anim_pixel(buf, x + dx, puffY + dy, level(v));
        };

        if (i == 0) {
            pix(0, 0, baseB);
            pix(-1, 0, bright(1));
            pix(-1, -1, bright(2));
            pix(-2, 0, bright(3));
        } else if (i == 1) {
            pix(0, 0, bright(1));
            pix(-1, 0, bright(3));
        } else if (i == 2) {
            pix(0, 0, bright(3));
            if (p == 2) pix(0, -1, bright(5));
        } else {
            pix(0, 0, bright(5));
        }
    }
}

void draw_idle_car_frame(unsigned long now, bool accelerating, bool smokeOn, bool engineOnState) {
    clear_anim_frame(frame_car_anim);

    int topY = 0;

    if (now - previousCarAnimMillis >= 110) {
        previousCarAnimMillis = now;
        if (engineOnState) carTick++;
    }

    if (accelerating && engineOnState) {
        long stepMs = CAR_SCROLL_INTERVAL_MS_BY_GEAR[constrain(currentGear, 1, 6)];
        if (now - previousCarMoveMillis >= (unsigned long)stepMs) {
            previousCarMoveMillis = now;
            // Scroll to the right and wrap in from the left after exiting.
            carX++;
            if (carX > COLS + EXHAUST_TRAIL_X) carX = -(int)SPR_W;
        }
    }

    if (!accelerating) {
        // Parked near center while idling.
        carX = 0;
    }

    draw_racecar(frame_car_anim, carX, topY, carTick, engineOnState);
    if (smokeOn) {
        draw_exhaust(frame_car_anim, carX, topY, carTick);
    }

    if (!engineOnState) {
        dim_frame(frame_car_anim, 2);
    }

    draw_with_revbar(frame_car_anim, revBarLit);
}

void setup() {
    Bridge.begin();
    Modulino.begin(Wire1);

    while (!movement.begin()) {
        delay(1000);
    }
    buttons.begin();

    matrix.begin();
    matrix.setGrayscaleBits(3);
    matrix.draw(frame_engine_off);
    pixelsConnected = pixels.begin();
    if (pixelsConnected) {
        pixels.clear();
        pixels.show();
    }

    // MPU pushes low-rate ML events; MCU owns frame-rate animation timing.
    Bridge.provide("ml_state_update", on_ml_state_update);
    Bridge.provide("ml_gear_up", on_ml_gear_up);
    Bridge.provide("button_b_reset_ack", on_button_b_reset_ack);
    Bridge.provide("ui_button_a_press", on_ui_button_a_press);
    Bridge.provide("ui_button_b_press", on_ui_button_b_press);
    Bridge.provide("ui_button_c_set", on_ui_button_c_set);
}

void loop() {
    unsigned long now = millis();

    if (now - previousPixelsStateBroadcastMillis >= PIXELS_STATE_BROADCAST_MS) {
        previousPixelsStateBroadcastMillis = now;
        Bridge.notify("pixels_connected_state", (int)(pixelsConnected ? 1 : 0));
    }

    // Periodic authoritative state sync keeps Python/UI aligned if button events
    // occurred before Linux services/websocket were online.
    if (now - previousStateSyncMillis >= STATE_SYNC_MS) {
        previousStateSyncMillis = now;
        Bridge.notify(
            "wheel_state_sync",
            (int)(engineIsOn ? 1 : 0),
            (int)(prevC ? 1 : 0),
            currentGear,
            (int)(bResetRequestPending ? 1 : 0)
        );

        if (bResetRequestPending) {
            Bridge.notify("button_b_reset_level");
        }
    }

    // Sensor reading at 62.5 Hz — continuously feeds Python for rev + steering updates.
    if (now - previousSensorMillis >= sensorInterval) {
        previousSensorMillis = now;
        has_movement = movement.update();
        if (has_movement == 1) {
            x_accel = movement.getX();
            y_accel = movement.getY();
            z_accel = movement.getZ();
        }
        Bridge.notify("record_sensor_movement", x_accel, y_accel, z_accel);
    }

    // Button polling at 20 Hz — edge-detect A/B, level-detect C
    if (now - previousBtnMillis >= btnInterval) {
        previousBtnMillis = now;
        buttons.update();
        bool a = buttons.isPressed(0) == HIGH;
        bool b = buttons.isPressed(1) == HIGH;
        bool c = buttons.isPressed(2) == HIGH;
        bool effectiveC = c || remoteCHeld;
        bool bPulseActive = (remoteBPulseUntil != 0) && (now < remoteBPulseUntil);
        bool effectiveB = b || bPulseActive;

        if (a && !prevA) {
            engineIsOn = !engineIsOn;
            Bridge.notify("button_a_press");
        }

        if (b && !prevB) {
            bPressActive = true;
            bHoldActionSent = false;
            bPressStartMillis = now;
        }

        if (bPressActive && b && !bHoldActionSent && (now - bPressStartMillis >= B_HOLD_RESET_MS)) {
            bHoldActionSent = true;
            bResetRequestPending = true;
            Bridge.notify("button_b_reset_level");
        }

        if (!b && prevB) {
            if (bPressActive && !bHoldActionSent) {
                if (currentGear > 1) {
                    currentGear--;
                    if (engineIsOn) {
                        rpmPct = max(rpmPct, 0.55f);
                    }
                    Bridge.notify("button_b_downshift", currentGear);
                }
            }
            bPressActive = false;
            bHoldActionSent = false;
        }

        if (effectiveC != prevC)  Bridge.notify("button_c_state", (int)(effectiveC ? 1 : 0));

        buttons.setLeds(engineIsOn, effectiveB, effectiveC);
        prevA = a; prevB = b; prevC = effectiveC;
    }

    // LED matrix at ~30 Hz — uses local timing and latest MPU event hints.
    if (now - previousLedMillis >= ledInterval) {
        previousLedMillis = now;
        update_rpm_state(now);

        // If MPU state becomes stale, drop to idle and use local accel hint.
        if ((now - lastMpuStateMillis) > MPU_STATE_TIMEOUT_MS) {
            currentState = "idle";
            steerDir = 0;
        }

        // ── LED display logic ──────────────────────────────────────────────
        if (!engineIsOn) {
            draw_idle_car_frame(now, false, false, false);
            update_pixels_revs(false, 0, false);
        } else if (now - gearChangeTime < GEAR_DISPLAY_MS) {
            draw_with_revbar(frame_gears[currentGear - 1], revBarLit);
            update_pixels_revs(true, revBarLit, false);
        } else if (atRedline) {
            // Flash upshift arrow every 200 ms
            if (now - arrowFlashTime >= 200) {
                arrowFlashTime = now;
                arrowFlash     = !arrowFlash;
            }
            if (arrowFlash) draw_with_revbar(frame_shift_arrow, revBarLit);
            else draw_idle_car_frame(now, prevC, true, true);
            update_pixels_revs(true, revBarLit, arrowFlash);
        } else if (currentState == "steering") {
            int resolvedDir = steerDir;
            if (resolvedDir == 0) {
                if (x_accel < -0.15) resolvedDir = -1;
                else if (x_accel > 0.15) resolvedDir = 1;
            }
            if (resolvedDir < 0)      draw_with_revbar(frame_steer_left, revBarLit);
            else if (resolvedDir > 0) draw_with_revbar(frame_steer_right, revBarLit);
            else                      draw_idle_car_frame(now, false, true, true);
            update_pixels_revs(true, revBarLit, false);
        } else {
            bool accelerating = prevC;
            draw_idle_car_frame(now, accelerating, true, true);
            update_pixels_revs(true, revBarLit, false);
        }
    }
}
