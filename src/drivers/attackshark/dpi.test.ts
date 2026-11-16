import assert from "node:assert/strict";
import test from "node:test";

import {
  buildX11DpiReport,
  decodeX11DpiReport,
  encodeX11DpiByte,
  nearestX11Dpi,
  X11_DPI_DEFAULT_ACTIVE,
  X11_DPI_DEFAULT_STAGES,
  X11_DPI_MAX,
  X11_DPI_MIN,
  X11_DPI_DEFAULT_COLORS,
  x11ColorHex,
  x11ParseColor,
  x11StageCount,
  x11StageMask,
} from "../../compx/x11-dpi.ts";

test("nearestX11Dpi clamps to the sensor range and rounds up to a real step", () => {
  assert.equal(nearestX11Dpi(10), X11_DPI_MIN);
  assert.equal(nearestX11Dpi(801), 850);
  assert.equal(nearestX11Dpi(800), 800);
  assert.equal(nearestX11Dpi(23000), X11_DPI_MAX);
  assert.equal(nearestX11Dpi(22000), 22000);
});

test("encodeX11DpiByte uses the hardware register map", () => {
  assert.equal(encodeX11DpiByte(800), 0x12);
  assert.equal(encodeX11DpiByte(1600), 0x25);
  assert.equal(encodeX11DpiByte(22000), 0x81);
});

test("buildX11DpiReport lays out the default table exactly like the reference driver", () => {
  const report = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
  });
  assert.equal(report.length, 56);
  assert.deepEqual([...report.subarray(0, 3)], [0x04, 0x38, 0x01]);
  assert.equal(report[3], 0x00);
  assert.equal(report[4], 0x01);
  assert.equal(report[5], 0x3f);
  // Default stage 6 is 22,000: mask bit 5 set on both mask bytes, its high
  // flag set, its byte 0x81.
  assert.equal(report[6], 0x20);
  assert.equal(report[7], 0x20);
  assert.deepEqual([...report.subarray(8, 14)], [0x12, 0x25, 0x38, 0x4b, 0x75, 0x81]);
  assert.deepEqual([...report.subarray(16, 22)], [0, 0, 0, 0, 0, 0x01]);
  assert.equal(report[24], X11_DPI_DEFAULT_ACTIVE);
  const sum = report.subarray(3, 50).reduce((acc, byte) => (acc + byte) & 0xffff, 0);
  assert.equal((report[50] << 8) | report[51], sum);
});

test("wired units emit the first 52 bytes only", () => {
  const report = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
    wired: true,
  });
  assert.equal(report.length, 52);
});

test("decodeX11DpiReport round-trips a table across every stage category", () => {
  const config = {
    stages: [500, 8000, 11000, 15000, 21000, 22000],
    activeStage: 3,
    angleSnap: true,
    rippleControl: false,
  };
  const decoded = decodeX11DpiReport(buildX11DpiReport(config));
  assert.deepEqual(decoded, {
    ...config,
    stageMask: 0x3f,
    colors: X11_DPI_DEFAULT_COLORS.map((rgb) => [...rgb]),
  });
});

test("decodeX11DpiReport accepts a report-id-stripped read-back", () => {
  const full = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
  });
  const stripped = new Uint8Array(full.subarray(1));
  const decoded = decodeX11DpiReport(stripped);
  assert.deepEqual(decoded?.stages, [...X11_DPI_DEFAULT_STAGES]);
  assert.equal(decoded?.activeStage, X11_DPI_DEFAULT_ACTIVE);
});

test("decodeX11DpiReport rejects a bad signature or checksum", () => {
  const good = buildX11DpiReport({
    stages: [...X11_DPI_DEFAULT_STAGES],
    activeStage: X11_DPI_DEFAULT_ACTIVE,
    angleSnap: false,
    rippleControl: true,
  });
  const badSignature = new Uint8Array(good);
  badSignature[0] = 0x02;
  assert.equal(decodeX11DpiReport(badSignature), null);

  const badChecksum = new Uint8Array(good);
  badChecksum[51] = (badChecksum[51] + 1) & 0xff;
  assert.equal(decodeX11DpiReport(badChecksum), null);

  assert.equal(decodeX11DpiReport(new Uint8Array([0x38, 0x01])), null);
});

test("buildX11DpiReport keeps byte 7 clear for firmware with separate page masks (X8 SE)", () => {
  const config = {
    stages: [800, 1600, 11000, 16000, 21000, 22000],
    activeStage: 2,
    angleSnap: false,
    rippleControl: true,
  };
  const x11 = buildX11DpiReport(config);
  const x8se = buildX11DpiReport({ ...config, separatePageMasks: true });

  // Stages 4-6 are above 12,000: byte 6 flags them on both firmwares.
  assert.equal(x11[6], 0b111000);
  assert.equal(x8se[6], 0b111000);
  // The X11 mirrors the mask into byte 7; the X8 SE reserves byte 7 for > 22,000.
  assert.equal(x11[7], 0b111000);
  assert.equal(x8se[7], 0x00);

  // Everything else is the same frame, and the checksum still covers bytes 3..49.
  for (let i = 0; i < 50; i++) {
    if (i !== 7) assert.equal(x8se[i], x11[i], `byte ${i}`);
  }
  const decoded = decodeX11DpiReport(x8se);
  assert.deepEqual(decoded?.stages, config.stages);
  assert.equal(decoded?.activeStage, 2);
});

test("separatePageMasks changes nothing for tables at or below 12,000", () => {
  const config = { stages: [400, 800, 1600, 3200, 6400, 12000], activeStage: 3, angleSnap: true, rippleControl: false };
  assert.deepEqual([...buildX11DpiReport({ ...config, separatePageMasks: true })], [...buildX11DpiReport(config)]);
});

test("the enabled-stage mask and the stage colours survive a write and read back", () => {
  const colors: [number, number, number][] = [
    [0x12, 0x34, 0x56], [0, 0xff, 0], [0, 0, 0xff], [0xff, 0xff, 0],
    [0, 0xff, 0xff], [0xff, 0, 0xff], [0xff, 0x40, 0], [0xff, 0xff, 0xff],
  ];
  const report = buildX11DpiReport({
    stages: X11_DPI_DEFAULT_STAGES,
    activeStage: 2,
    angleSnap: false,
    rippleControl: true,
    stageMask: x11StageMask(3),
    colors,
  });
  assert.equal(report[5], 0x07);
  assert.deepEqual([...report.subarray(25, 28)], [0x12, 0x34, 0x56]);
  const decoded = decodeX11DpiReport(report);
  assert.ok(decoded);
  assert.equal(decoded.stageMask, 0x07);
  assert.equal(x11StageCount(decoded.stageMask!), 3);
  assert.deepEqual(decoded.colors?.[0], [0x12, 0x34, 0x56]);
});

test("without a mask or colours the report keeps every stage and the factory palette", () => {
  const report = buildX11DpiReport({ stages: X11_DPI_DEFAULT_STAGES, activeStage: 1, angleSnap: false, rippleControl: true });
  assert.equal(report[5], 0x3f);
  assert.deepEqual([...report.subarray(25, 49)], X11_DPI_DEFAULT_COLORS.flat());
});

test("stage-count helpers and colour parsing", () => {
  assert.equal(x11StageMask(1), 0x01);
  assert.equal(x11StageMask(6), 0x3f);
  assert.equal(x11StageMask(9), 0x3f);
  assert.equal(x11StageCount(0x0f), 4);
  assert.equal(x11StageCount(0), 1);
  assert.equal(x11ColorHex([0xff, 0x40, 0]), "#ff4000");
  assert.deepEqual(x11ParseColor("#FF4000"), [0xff, 0x40, 0]);
  assert.equal(x11ParseColor("red"), null);
});
