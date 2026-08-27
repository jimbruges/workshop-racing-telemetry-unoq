# Racing Telemetry Workshop

Racing Telemetry Workshop turns the Real-time Accelerometer Data example into a racing steering wheel demo with edge AI and live telemetry.

You still stream raw accelerometer data from Modulino Movement and classify motion with an Edge Impulse model, but this workshop adds a race-oriented interaction layer:

- Steering and gear-change gestures are detected in real time.
- Engine and gearbox interactions are handled with Modulino Buttons.
- A live web dashboard shows telemetry, state, and motion confidence.
- The built-in LED matrix and optional Modulino Pixels act like an on-wheel race display (rev bar, shift prompt, steering cues, gear display).

## How This Builds on Real-time Accelerometer Data

The original Real-time Accelerometer Data example demonstrates the core pipeline:

- Capture x/y/z acceleration from Modulino Movement.
- Send readings from MCU to Python through Bridge.
- Run edge model inference with the motion_detection Brick.
- Push results to a Web UI.

This workshop keeps that architecture, then extends it in four ways:

1. Domain-specific classes
   The model output classes are tuned for driving behavior: idle, steering, and gearchange.

2. Bidirectional control loop
   Telemetry flows from MCU to Python, while interpreted state flows back from Python to MCU so the display can react immediately.

3. Runtime calibration
   Steering angle offset and inversion can be adjusted at runtime and persisted.

4. Rich race HMI
   The web page and LED displays turn raw inference into driver-facing feedback: current motion confidence, steering direction, engine state, rev progression, and shift timing.

## Bricks Used

- `motion_detection` - runs edge inference on streamed movement samples.
- `web_ui` - serves the workshop UI and telemetry APIs/messages.

## AI Model Used

The app uses an Edge Impulse motion-classification model and applies it to racing-wheel interactions.

Model classes used in this workshop:
- **idle** - no intentional driving gesture is being made.
- **steering** - steering-like wheel movement is detected.
- **gearchange** - an upshift-style gesture is detected.

Reference model lineage:
- [Motion Classification - Continuous Motion Recognition](https://studio.edgeimpulse.com/public/497631/latest)

## Hardware Requirements

### Hardware

- Arduino UNO Q or Arduino VENTUNO Q
- USB-C cable
- Arduino Modulino Movement
- Arduino Modulino Buttons
- Qwiic cable
- Optional: Arduino Modulino Pixels (for external rev lights)

## How to Use the Example

1. Connect the board to your computer with USB-C.
2. Connect Modulino Movement and Modulino Buttons via Qwiic.
3. Optionally connect Modulino Pixels.
4. Launch the app from App Lab.
5. Open the UI at <BOARD-IP>:7000.

![Hardware setup](assets/docs_assets/hardware-setup.png)

## How it Works

This workshop keeps the Real-time Accelerometer Data architecture (sensor streaming + edge inference + Web UI) and extends it into a racing control loop.

The data pipeline starts on the MCU:
- Modulino Movement provides raw accelerometer values (`x`, `y`, `z`).
- Values are sent to Python over Bridge using `record_sensor_movement`.

On the Linux (Python) side:
- Samples are accumulated and passed to the `motion_detection` Brick.
- Inference output (`idle`, `steering`, `gearchange`) is converted into telemetry state.
- Live telemetry is broadcast to the Web UI.
- Motion hints are sent back to the MCU (`ml_state_update`, `ml_gear_up`) for low-latency dashboard behavior.

On the MCU side:
- The LED matrix renders steering cues, gear view, rev behavior, and redline shift prompts.
- Modulino Buttons handle engine toggle and downshift interactions.
- Optional Modulino Pixels mirror rev lights externally.

The result is a bidirectional system where edge AI inference drives race-style feedback in real time.

## Understanding the Code

Compared with the base accelerometer example, this project adds a richer telemetry and display layer while preserving the same core edge-AI flow.

### Linux (Python) Side

- `MotionDetection(confidence=CONFIDENCE)` initializes edge inference for motion classes.
- `record_sensor_movement(x, y, z)` receives MCU sensor data, accumulates samples, and computes steering angle and direction hints.
- `on_movement_detected(classification)` normalizes model output, selects dominant state, and triggers state updates to UI and MCU.
- `Bridge.notify("ml_state_update", ...)` and `Bridge.notify("ml_gear_up")` push interpreted motion events back to the sketch.
- `web_ui.expose_api("GET", "/detection", ...)` and `web_ui.expose_api("GET", "/config", ...)` expose motion and calibration state.
- `on_angle_calibration(...)` persists runtime steering calibration to `runtime_config.json`.

### Microcontroller (Sketch) Side

- `Bridge.notify("record_sensor_movement", x_accel, y_accel, z_accel)` streams accelerometer data to Python.
- `Bridge.provide("ml_state_update", on_ml_state_update)` receives steering/idle state hints.
- `Bridge.provide("ml_gear_up", on_ml_gear_up)` receives AI-triggered upshift events.
- Button A toggles engine state, button B performs downshift, button C controls acceleration/rev behavior.
- LED matrix rendering combines local timing with AI hints for steering arrows, gear display, rev bar, and redline flash.
- Optional Modulino Pixels mirror rev segments as external shift lights.

## Workshop Flow

1. Start with engine off and observe the idle display state.
2. Toggle engine state using button A.
3. Hold button C to build revs and trigger redline behavior.
4. Press button B to downshift.
5. Perform steering and gear-change gestures and watch classification confidence in the UI.
6. Observe how edge AI outputs drive LED matrix and rev indicators.

## Related Reference

- Base concept: Real-time Accelerometer Data example.
- Edge model source: Motion Classification - Continuous Motion Recognition.

## Notes

- The app uses one running instance model: starting this app will stop any currently running app.
- Keep model path and Brick configuration aligned with app.yaml when packaging.
