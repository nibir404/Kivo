import { Battery, CircuitBoard, Cpu, HardDrive, ListChecks, Microchip, Radio, Terminal, Thermometer, Upload } from "lucide-react"
import { hasTech } from "../derive"
import { jitter, match, stem, type WorkspaceDef } from "../model"

const FIRMWARE = /(^|\/)(src|lib|firmware|main|components)\/.*\.(c|cpp|cc|h|hpp|ino|rs)$|\.ino$/
const BOARD_CFG = /(platformio\.ini|sdkconfig|prj\.conf|west\.yml|CMakeLists\.txt|Cargo\.toml|memory\.x|.*\.ld)$/
const SENSOR = /(bme|bmp|dht|mpu|lsm|ads|ina|sht|vl53|max3|hx711|ccs811|sensor|imu|adc|i2c|spi|uart)/i

const noise = jitter("emb-pwr", 16, 0, 3)
const WAKE_CURRENT = [0.01, 0.01, 45, 120, 150, 140, 95, 80, 82, 78, 60, 20, 0.01, 0.01, 0.01, 0.01].map((v, i) => Math.round(Math.max(0, v + (v > 1 ? noise[i] : 0)) * 100) / 100)

export const embedded: WorkspaceDef = {
  id: "embedded",
  label: "Embedded / IoT",
  icon: Microchip,
  hue: 95,
  tagline: "Firmware close to the metal: boards, sensors, memory and power.",
  primaryMode: "Build",
  hero: { title: "What should the device do?", body: "Describe the hardware, what it senses and where the data goes. Kivo plans the firmware, the peripherals and the memory budget." },
  placeholder: "e.g. An ESP32 that reads temperature every minute and posts it to the backend over Wi-Fi, sleeping in between",
  examples: [
    { icon: Thermometer, label: "Temperature logger", text: "Write firmware for an ESP32 with a BME280 sensor that reads temperature and humidity every 60 s, posts it to this project's backend over HTTPS, and deep-sleeps in between." },
    { icon: Upload, label: "OTA updates", text: "Add safe over-the-air firmware updates to an ESP32 project: signed images, A/B partitions and automatic rollback." },
    { icon: Battery, label: "Battery budget", text: "Estimate battery life for a sensor node on a 2000 mAh cell that wakes every 5 minutes, and suggest how to double it." },
  ],
  looksFor: ["platformio.ini", "*.ino (Arduino)", "sdkconfig (ESP-IDF), prj.conf / west.yml (Zephyr)", "src/*.c, *.cpp firmware sources", "linker scripts, memory.x"],
  relevant: (_t, cat) => cat === "Embedded",
  stats: (ctx) => [
    { label: "Firmware sources", value: String(match(ctx.files, FIRMWARE).length) },
    { label: "Board configs", value: String(match(ctx.files, BOARD_CFG).filter((f) => !/CMakeLists|Cargo/.test(f) || hasTech(ctx, "PlatformIO", "ESP-IDF", "Zephyr")).length) },
    { label: "Toolchain", value: ctx.analysis.detections.find((d) => d.category === "Embedded")?.tech ?? "—" },
    { label: "Sensor drivers", value: String(match(ctx.files, FIRMWARE).filter((f) => SENSOR.test(f)).length) },
  ],
  sections: [
    {
      id: "devices",
      label: "Devices & boards",
      icon: CircuitBoard,
      blurb: "Target boards, their microcontroller and memory.",
      setup: "Set up a PlatformIO project for an ESP32 in this repository, with a board definition, build flags and a serial monitor config.",
      build: (ctx) => {
        const cfg = match(ctx.files, /platformio\.ini$|sdkconfig$|prj\.conf$/)
        if (cfg.length) return { source: "project", evidence: cfg, count: cfg.length, note: "Open the config in Code to see each environment.", panels: [{ kind: "table", columns: [{ key: "file", label: "Board config", mono: true }], rows: cfg.map((f) => ({ file: { text: f, mono: true } })) }] }
        return {
          source: "example",
          note: "No board configuration yet.",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "env", label: "Environment", mono: true },
                { key: "mcu", label: "MCU" },
                { key: "flash", label: "Flash", align: "right" },
                { key: "ram", label: "RAM", align: "right" },
                { key: "radio", label: "Radio" },
              ],
              rows: [
                { env: "esp32dev", mcu: "ESP32 · 240 MHz dual-core", flash: "4 MB", ram: "520 KB", radio: "Wi-Fi · BLE" },
                { env: "nrf52840", mcu: "nRF52840 · 64 MHz", flash: "1 MB", ram: "256 KB", radio: "BLE · Thread" },
              ],
            },
          ],
        }
      },
    },
    {
      id: "firmware",
      label: "Firmware",
      icon: Cpu,
      blurb: "Source modules that run on the device.",
      build: (ctx) => {
        const files = match(ctx.files, FIRMWARE)
        return files.length
          ? { source: "project", evidence: files, count: files.length, panels: [{ kind: "table", columns: [{ key: "mod", label: "Module" }, { key: "file", label: "File", mono: true }], rows: files.map((f) => ({ mod: stem(f), file: { text: f, mono: true } })) }] }
          : {
              source: "example",
              note: "No firmware sources yet.",
              panels: [
                {
                  kind: "table",
                  columns: [
                    { key: "mod", label: "Module" },
                    { key: "does", label: "Responsibility" },
                  ],
                  rows: [
                    { mod: "main.cpp", does: "Boot, wake-up reason, scheduling" },
                    { mod: "sensors.cpp", does: "Read and calibrate the BME280" },
                    { mod: "net.cpp", does: "Wi-Fi connect, HTTPS post with retry" },
                    { mod: "power.cpp", does: "Deep sleep and brown-out handling" },
                  ],
                },
              ],
            }
      },
    },
    {
      id: "peripherals",
      label: "Sensors & buses",
      icon: Radio,
      blurb: "What's wired to which bus and pin.",
      build: (ctx) => {
        const drivers = match(ctx.files, FIRMWARE).filter((f) => SENSOR.test(f))
        if (drivers.length) return { source: "project", evidence: drivers, count: drivers.length, panels: [{ kind: "table", columns: [{ key: "drv", label: "Driver" }, { key: "file", label: "File", mono: true }], rows: drivers.map((f) => ({ drv: stem(f), file: { text: f, mono: true } })) }] }
        return {
          source: "example",
          panels: [
            {
              kind: "table",
              columns: [
                { key: "part", label: "Part" },
                { key: "bus", label: "Bus" },
                { key: "addr", label: "Address / pins", mono: true },
                { key: "rate", label: "Sample rate", align: "right" },
              ],
              rows: [
                { part: "BME280 (temp · humidity · pressure)", bus: "I²C", addr: "0x76 · SDA 21 / SCL 22", rate: "1 / min" },
                { part: "MPU-6050 (IMU)", bus: "I²C", addr: "0x68", rate: "100 Hz" },
                { part: "Status LED", bus: "GPIO", addr: "GPIO 2", rate: "—" },
              ],
            },
          ],
        }
      },
    },
    {
      id: "memory",
      label: "Memory budget",
      icon: HardDrive,
      blurb: "Flash and RAM used by the firmware image.",
      build: () => ({
        source: "example",
        note: "Example build output. Leave RAM headroom for the Wi-Fi and TLS stacks, which allocate at runtime.",
        panels: [
          {
            kind: "metrics",
            tiles: [
              { label: "Flash", value: "1.02 / 1.31 MB", hint: "78 % of app partition", tone: "warn" },
              { label: "Static RAM", value: "48 / 320 KB", hint: "15 %", tone: "good" },
              { label: "Free heap (min)", value: "92 KB", tone: "good" },
            ],
            charts: [],
          },
        ],
      }),
    },
    {
      id: "power",
      label: "Power",
      icon: Battery,
      blurb: "Current draw across a wake cycle, and the battery life it implies.",
      build: () => ({
        source: "example",
        panels: [
          {
            kind: "metrics",
            tiles: [
              { label: "Awake", value: "82 mA · 1.9 s" },
              { label: "Deep sleep", value: "11 µA" },
              { label: "Est. battery life", value: "~7 months", hint: "2000 mAh, wake every 5 min", tone: "good" },
            ],
            charts: [{ title: "Current draw during one wake", unit: "mA", x: "100 ms", series: [{ name: "current", points: WAKE_CURRENT }] }],
          },
        ],
      }),
    },
    {
      id: "serial",
      label: "Serial monitor",
      icon: Terminal,
      blurb: "What the device prints while it runs.",
      build: (ctx) => ({
        source: "example",
        note: hasTech(ctx, "PlatformIO") ? "Run `pio device monitor` in the terminal to see live output." : "Connect a board and run your toolchain's monitor in the terminal. Example output:",
        panels: [
          {
            kind: "timeline",
            events: [
              { at: "00.000", title: "boot: wake reason = timer", tone: "neutral" },
              { at: "00.412", title: "bme280: 21.4 °C, 48 % RH, 1012 hPa", tone: "neutral" },
              { at: "01.380", title: "wifi: connected, RSSI -61 dBm", tone: "good" },
              { at: "01.902", title: "http: POST /readings → 201", tone: "good" },
              { at: "01.910", title: "sleep: 300 s", tone: "neutral" },
            ],
          },
        ],
      }),
    },
    {
      id: "ota",
      label: "Flash & OTA",
      icon: Upload,
      blurb: "Firmware releases and how they reach devices.",
      setup: "Plan firmware releases for this device: versioning, signed OTA images, staged rollout and rollback.",
      build: () => ({
        source: "example",
        panels: [
          {
            kind: "timeline",
            events: [
              { at: "v1.3.0", title: "Rolled out to 100 % of devices", detail: "Adds humidity calibration", tone: "good" },
              { at: "v1.2.1", title: "Rolled back on 3 devices", detail: "Brown-out on boot with weak batteries", tone: "bad" },
              { at: "v1.2.0", title: "Rolled out to 10 %", detail: "New Wi-Fi retry logic", tone: "info" },
            ],
          },
        ],
      }),
    },
    {
      id: "checklist",
      label: "Hardware checklist",
      icon: ListChecks,
      blurb: "Before a device leaves the bench.",
      build: () => ({
        source: "guide",
        panels: [
          {
            kind: "checklist",
            items: [
              { id: "watchdog", title: "A watchdog resets the device if the main loop hangs" },
              { id: "brownout", title: "Brown-out detection is on and tested with a weak supply" },
              { id: "ota-rollback", title: "A bad OTA image rolls back automatically" },
              { id: "secrets", title: "Wi-Fi and API credentials aren't compiled into the image in plain text" },
              { id: "time", title: "The clock is synced (NTP) before timestamps are trusted" },
              { id: "offline", title: "Readings are buffered while offline and sent later" },
            ],
          },
        ],
      }),
    },
  ],
}
