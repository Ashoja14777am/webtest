/* =====================================================================
 *  Digital instrument cluster – dashboard.js
 *  ---------------------------------------------------------------------
 *   1. CONFIG ............ everything you may want to customise
 *   2. TELEMETRY + STATE . telemetryData (WebSocket / simulator), dashboardState
 *   3. HELPERS
 *   4. DASHBOARDS ........ 0 Supra digital · 1 Supra classic · 2 Dodge Charger · 3 Ferrari · 4 BMW M3 GTR
 *   5. SIMULATOR ......... demo drive cycle (CONFIG.simulator.enabled)
 *   6. INIT / ORIENTATION / FULLSCREEN / CLOCK
 *   7. DASHBOARD UPDATE LOOP (fuel gauge, errors)
 *   8. CAR SWITCHER (selection is saved in localStorage)
 *   9. WEBSOCKET
 *  10. THEME + EXPORT
 * ===================================================================== */

// =====================================================================
// 1. CONFIG
// =====================================================================
const CONFIG = {
    storageKey: 'clusterState',        // localStorage key: selected dashboard, drive mode, hint seen
    clock24h: true,
    fullscreenOverlay: true,           // "Click anywhere to enter Fullscreen" screen
    orientation: 'overlay',            // 'overlay' = ask to rotate | 'rotate' = rotate the stage automatically
    introSweepSeconds: 1.8,            // start-up needle test, once per dashboard and session (0 = off)

    websocket: {
        enabled: true,
        path: '/ws',                   // ws://<host><path>
        retryMs: 2000,
        hello: { page: 'dashboard' }   // first message sent after connecting
    },

    // Demo drive cycle. Pauses by itself while live telemetry arrives over the WebSocket.
    // Set enabled:false when the car is connected.
    simulator: {
        enabled: true,
        liveTimeoutMs: 3000,           // no live data for this long -> simulator resumes
        warmupPerSecond: 0.5,          // temperature rise (°C/s) up to 90 °C
        startBattery: 78               // battery % the demo starts from
    },

    // The car's "fuel" is its battery: every fuel gauge shows batteryLevel
    fuel:    { rangeMaxKm: 560, lowFraction: 0.15 },
    battery: { lowPercent: 20 },       // battery warning light (M3 GTR)
    lapKm: 1.5,                        // distance of one lap for the M3 GTR lap timer

    // Start values of the odometer / trip read-outs
    odometer: { totalKm: 105, tripKm: 105.4, supraKm: 129355, supraTripKm: 3049.9, chargerMiles: 78632, chargerTripMiles: 61.4 },

    // Page background for each saved theme (carSettings.theme). All black for now.
    themes: { dark: '#000', light: '#000', systemDark: '#000', systemLight: '#000' }
};

// Telemetry error keys -> chip label
const ERRORS = {
    esc:   { chip: 'ESC' },
    radio: { chip: 'RADIO' },
    led:   { chip: 'LED' },
    sound: { chip: 'SOUND' },
    imu:   { chip: 'IMU' }
};

// Drive modes (digital dashboard). power = acceleration, up/dn = gear-shift rpm
const DRIVE_MODES = {
    eco:     { label: 'ECO',     power: 12, vmax: 160, up: 2300, dn: 1000 },
    comfort: { label: 'COMFORT', power: 22, vmax: 250, up: 3000, dn: 1300 },
    sport:   { label: 'SPORT',   power: 32, vmax: 250, up: 5600, dn: 3000 }
};
const GEAR_RATIOS = [0, 90, 52, 35, 26.5, 21, 17.5, 15, 13];   // rpm per km/h, gears 1..8

// Stage geometry (viewBox units)
const DESIGN = { width: 1355, contentHeight: 525, buttonBar: 84, minHeight: 600, maxHeight: 780, viewX: -70 };

// =====================================================================
// 2. TELEMETRY + STATE
// =====================================================================
// Dashboard telemetry data (updated by the WebSocket or by the simulator)
const telemetryData = {
    speed: 0,
    rpm: 0,
    batteryLevel: 15,
    groundClearance: 15.2,
    temperature: 22,
    fuelLevel: 78,
    throttle: 0,                       // optional 0..1 – only used for gauges / consumption
    // optional extras for the M3 GTR display (null = not sent -> '--' or calculated)
    oilTemp: null, oilPressure: null, fuelPressure: null,
    lap: null, lapTime: null, bestLap: null,
    errors: {
        esc: false,
        radio: false,
        led: false,
        sound: true,
        imu: false
    },
    calCenter: null,
    calMax: null,
    calMin: null
};

// Dashboard state
const dashboardState = {
    isFullscreen: false,
    animationFrameId: null,
    current: 0,                        // index in DASHBOARDS (saved)
    mode: 'sport',                     // drive profile used by the simulator / gear logic (eco | comfort | sport)
    swipeHintSeen: false,              // (saved)
    busy: false                        // car switch animation running
};

// Values calculated from telemetry (gear, trip, consumption …)
const derived = { gear: 1, gearCooldown: 0, gearLabel: 'P', trip: 0, movingSeconds: 0, consumption: 22.4, lap: 1, lapSeconds: 0, lapDistance: 0, bestLap: null, prevSpeed: 0, longG: 0, peakAccel: 0, peakBrake: 0 };
const clockNodes = [];   // every text node that shows the time

// Live-data bookkeeping (lets the simulator step aside)
const liveState = { lastTelemetryAt: -Infinity };

// Cached DOM elements
const el = {};

// Persistent storage (localStorage, never throws)
const store = {
    load() {
        try { return JSON.parse(localStorage.getItem(CONFIG.storageKey)) || {}; }
        catch (e) { return {}; }
    },
    save(patch) {
        try { localStorage.setItem(CONFIG.storageKey, JSON.stringify({ ...this.load(), ...patch })); }
        catch (e) { /* storage unavailable */ }
    }
};

function restoreState() {
    const saved = store.load();
    const index = Number.isInteger(saved.dashboard) ? saved.dashboard : 0;
    dashboardState.current = (index >= 0 && index < DASHBOARDS.length) ? index : 0;
    dashboardState.swipeHintSeen = !!saved.swipeHintSeen;
}

// Merge a telemetry message into telemetryData (known keys only)
const NUMERIC_KEYS = ['speed', 'rpm', 'batteryLevel', 'groundClearance', 'temperature', 'fuelLevel', 'throttle', 'oilTemp', 'oilPressure', 'fuelPressure', 'lap', 'lapTime', 'bestLap'];
function applyTelemetry(data) {
    Object.keys(data).forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(telemetryData, key)) return;
        const value = data[key];
        if (key === 'errors') {
            if (value && typeof value === 'object') Object.assign(telemetryData.errors, value);
        } else if (NUMERIC_KEYS.includes(key)) {
            if (value === null) { telemetryData[key] = null; return; }
            const n = Number(value);
            if (Number.isFinite(n)) telemetryData[key] = n;
        } else {
            telemetryData[key] = value;
        }
    });
}

// =====================================================================
// 3. HELPERS
// =====================================================================
const SVG_NS = 'http://www.w3.org/2000/svg';
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const byId = id => document.getElementById(id);
const fuelFraction = () => clamp(telemetryData.batteryLevel / 100, 0, 1);   // fuel = battery

function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) if (attrs[key] != null) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
}

function setText(node, value) {
    const text = String(value);
    if (node && node.textContent !== text) node.textContent = text;
}

// Smooth Catmull-Rom style path through points
function smoothPath(p) {
    let d = 'M' + p[0];
    for (let i = 0; i < p.length - 1; i++) {
        const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], e = p[i + 2] || c;
        d += `C${b[0] + (c[0] - a[0]) / 6} ${b[1] + (c[1] - a[1]) / 6} ${c[0] - (e[0] - b[0]) / 6} ${c[1] - (e[1] - b[1]) / 6} ${c[0]} ${c[1]}`;
    }
    return d;
}

// Offset a polyline by `dist` towards `focus`
function offsetPath(p, dist, focus) {
    return p.map((q, i) => {
        const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
        const m = Math.hypot(b[0] - a[0], b[1] - a[1]);
        let nx = -(b[1] - a[1]) / m, ny = (b[0] - a[0]) / m;
        if ((focus[0] - q[0]) * nx + (focus[1] - q[1]) * ny < 0) { nx = -nx; ny = -ny; }
        return [q[0] + nx * dist, q[1] + ny * dist];
    });
}

const rotateNode = (node, angle, cx, cy) => node.setAttribute('transform', `rotate(${angle} ${cx} ${cy})`);
const getDriveProfile = () => DASHBOARDS[dashboardState.current].drive || DRIVE_MODES[dashboardState.mode];

// =====================================================================
// 4. DASHBOARDS
// =====================================================================
// ---- 4a. shared builders: digital arcs ----------------------------------
const ARC_POINTS = [[260, 440], [170, 427], [102, 375], [70, 295], [52, 225], [80, 165], [150, 105], [240, 62], [335, 40], [445, 25]];
const FUEL_ARC_POINTS = [[115, 452], [65, 435], [30, 405], [28, 360], [55, 318]];
const mirrorX = pts => pts.map(p => [1215 - p[0], p[1]]);
const TICK_FRACTIONS = [0, 150, 245, 330, 466, 585, 685, 795].map(x => x / 801);

// Scale definitions – edit values / labels to re-scale the dials
const SPEED_DIAL = {
    values: [0, 20, 40, 60, 100, 140, 200, 260],
    labels: [{ text: '0', color: '#fff', dx: 50 }, { text: '20' }, { text: '40' }, { text: '60' }, { text: '100' }, { text: '140' }, { text: '200' }, { text: '260' }]
};
const RPM_DIAL = {                      // values in x1000 rpm
    values: [0, 1, 2, 3, 4, 5, 6, 8],
    labels: [{ text: '0', dx: -50 }, { text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }, { text: '5' }, { text: '6', color: '#ffd400' }, { text: '8', color: '#ff2a1f' }]
};
const RPM_ZONES = [{ from: 6, to: 6.4, color: '#ffd400' }, { from: 6.4, to: 8, color: '#ff2a1f' }];

function createDial(parent, { points, focus, values, labels }) {
    const outerPath = smoothPath(points);
    const innerPath = smoothPath(offsetPath(points, 12, focus));
    const layer = (width, opacity) => svgEl('path', { d: innerPath, fill: 'none', 'stroke-width': width, 'stroke-opacity': opacity, style: 'stroke:var(--acc)' }, parent);
    const glow = [layer(64, .09), layer(38, .16), layer(22, .3)];
    const band = layer(12, 1);
    const outline = svgEl('path', { d: outerPath, fill: 'none', stroke: '#fff', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, parent);
    const outerLength = outline.getTotalLength();
    const bandLength = band.getTotalLength();

    // point at `fraction` of the outline, pushed `dist` towards the dial centre
    const pointAt = (fraction, dist) => {
        const l = fraction * outerLength;
        const p = outline.getPointAtLength(l);
        const a = outline.getPointAtLength(Math.max(0, l - 3));
        const b = outline.getPointAtLength(Math.min(outerLength, l + 3));
        const m = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        let nx = -(b.y - a.y) / m, ny = (b.x - a.x) / m;
        if ((focus[0] - p.x) * nx + (focus[1] - p.y) * ny < 0) { nx = -nx; ny = -ny; }
        return [p.x + nx * dist, p.y + ny * dist];
    };

    // value -> fraction of the arc (piece-wise linear between ticks)
    const fraction = value => {
        for (let i = 1; i < values.length; i++) {
            if (value <= values[i]) {
                return TICK_FRACTIONS[i - 1] + Math.max(0, (value - values[i - 1]) / (values[i] - values[i - 1])) * (TICK_FRACTIONS[i] - TICK_FRACTIONS[i - 1]);
            }
        }
        return 1;
    };

    values.forEach((v, i) => {
        const base = pointAt(TICK_FRACTIONS[i], 0), tickEnd = pointAt(TICK_FRACTIONS[i], 36), labelPos = pointAt(TICK_FRACTIONS[i], 74);
        const label = labels[i];
        svgEl('line', { x1: base[0], y1: base[1], x2: tickEnd[0], y2: tickEnd[1], stroke: '#fff', 'stroke-width': 2.5 }, parent);
        svgEl('text', {
            x: labelPos[0] + (label.dx || 0), y: labelPos[1] + (label.dx ? 20 : 0), class: 'num',
            'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 29,
            style: label.color ? 'fill:' + label.color : null
        }, parent).textContent = label.text;
    });

    const cap = svgEl('line', { stroke: '#fff', 'stroke-width': 4, 'stroke-linecap': 'round' }, parent);
    let lastFraction = -1;
    return {
        fraction,
        length: outerLength,
        path: outerPath,
        set(f) {
            f = clamp(f, 0, 1);
            if (f === lastFraction) return;
            lastFraction = f;
            const dash = f * bandLength + ' 9999';
            band.setAttribute('stroke-dasharray', dash);
            glow.forEach(g => g.setAttribute('stroke-dasharray', dash));
            const a = pointAt(f, -2), b = pointAt(f, 98);
            cap.setAttribute('x1', a[0]); cap.setAttribute('y1', a[1]);
            cap.setAttribute('x2', b[0]); cap.setAttribute('y2', b[1]);
            cap.style.opacity = f < .004 ? 0 : 1;
        }
    };
}

// Small fuel / temperature arc. Returns setter(fraction, colour)
function createMiniArc(parent, points, focus) {
    const fill = svgEl('path', { d: smoothPath(offsetPath(points, 7, focus)), fill: 'none', 'stroke-width': 6 }, parent);
    const length = fill.getTotalLength();
    svgEl('path', { d: smoothPath(points), fill: 'none', stroke: '#fff', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, parent);
    return (f, color) => {
        fill.setAttribute('stroke-dasharray', clamp(f, 0, 1) * length + ' 9999');
        fill.style.stroke = color;
    };
}

// ---- 4b. shared builders: classic round gauges --------------------------
const WHITE = '#eef3f8';
const SERIF = "font-family:Georgia,'Times New Roman',serif;font-weight:700;";

function addText(parent, x, y, text, size, { serif = false, color = WHITE } = {}) {
    const node = svgEl('text', {
        x, y, class: 'txt', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size,
        style: `fill:${color};${serif ? SERIF : 'font-weight:500;'}`
    }, parent);
    node.textContent = text;
    return node;
}

function drawFace(parent, cx, cy, r, ringWidth = .07) {
    svgEl('circle', { cx, cy, r: r * 1.02, fill: '#000', opacity: .6 }, parent);
    svgEl('circle', { cx, cy, r: r * .965, fill: 'none', stroke: 'url(#gradChrome)', 'stroke-width': r * ringWidth }, parent);
    svgEl('circle', { cx, cy, r: r * .93, fill: 'url(#gradFace)', stroke: '#000', 'stroke-width': r * .02 }, parent);
}

function drawScale(parent, cx, cy, r, startAngle, sweep, v0, v1, major, minor, labelFn, fontSize, redFrom) {
    const pos = (v, k) => {
        const t = (startAngle + sweep * (v - v0) / (v1 - v0)) * Math.PI / 180;
        return [cx + r * k * Math.cos(t), cy + r * k * Math.sin(t)];
    };
    const steps = Math.round((v1 - v0) / minor);
    for (let i = 0; i <= steps; i++) {
        const v = v0 + i * minor;
        const big = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        const a = pos(v, .86), b = pos(v, big ? .74 : .8);
        svgEl('line', {
            x1: a[0], y1: a[1], x2: b[0], y2: b[1],
            stroke: (redFrom != null && v >= redFrom - 1e-6) ? '#ff5a2a' : WHITE,
            'stroke-width': r * (big ? .016 : .009), 'stroke-linecap': 'round'
        }, parent);
    }
    for (let v = v0; v <= v1 + 1e-6; v += major) {
        const s = labelFn(v);
        if (s != null) { const p = pos(v, .6); addText(parent, p[0], p[1], s, fontSize); }
    }
}

function createNeedle(parent, cx, cy, length, halfWidth, color) {
    const g = svgEl('g', {}, parent);
    svgEl('polygon', {
        points: `${cx - length * .18},${cy - halfWidth} ${cx + length},${cy} ${cx - length * .18},${cy + halfWidth}`,
        fill: color || 'url(#gradHub)', stroke: '#000', 'stroke-opacity': .4
    }, g);
    return g;
}
const drawHub  = (parent, cx, cy, r) => svgEl('circle', { cx, cy, r, fill: 'url(#gradHub)', stroke: '#2a2c30' }, parent);
const drawDisc = (parent, cx, cy, r) => svgEl('circle', { cx, cy, r, fill: '#26272a', stroke: '#5b5d62', 'stroke-width': 2 }, parent);

function drawBox(parent, x, y, w, h) { svgEl('rect', { x, y, width: w, height: h, fill: '#050505', stroke: '#444' }, parent); }
function drawReadout(parent, x, y, size, spacing) {
    return svgEl('text', { x, y, class: 'txt', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size, style: `fill:#fff;letter-spacing:${spacing}px` }, parent);
}

// ---- 4c. DASHBOARD 0 : SUPRA DIGITAL ------------------------------------
const digital = {};

function buildSupraDigital() {
    const group = byId('dashSupraDigital');
    digital.speedDial = createDial(group, { points: ARC_POINTS, focus: [330, 290], ...SPEED_DIAL });
    digital.rpmDial = createDial(group, { points: mirrorX(ARC_POINTS), focus: [885, 290], ...RPM_DIAL });

    // coloured rev-limit zones on the rpm arc
    RPM_ZONES.forEach(zone => {
        const f1 = digital.rpmDial.fraction(zone.from), f2 = digital.rpmDial.fraction(zone.to);
        svgEl('path', {
            d: digital.rpmDial.path, fill: 'none', stroke: zone.color, 'stroke-width': 7,
            'stroke-dasharray': (f2 - f1) * digital.rpmDial.length + ' ' + digital.rpmDial.length * 3,
            'stroke-dashoffset': -f1 * digital.rpmDial.length
        }, group);
    });

    digital.setFuel = createMiniArc(group, FUEL_ARC_POINTS, [200, 360]);
    digital.setTemp = createMiniArc(group, mirrorX(FUEL_ARC_POINTS), [1015, 360]);
    digital.speedDial.set(0);
    digital.rpmDial.set(0);
    digital.setFuel(.86, 'var(--or)');
    digital.setTemp(.17, '#6fc3ff');

    ['speedValue', 'gearValue', 'totalValue', 'tripValue', 'consumptionValue', 'avgSpeedValue', 'rangeValue', 'temperatureValue']
        .forEach(id => { digital[id] = byId(id); });
}

function updateSupraDigital(ctx) {
    const d = digital, t = telemetryData;

    if (ctx.sweep != null) {                       // start-up needle sweep
        d.speedDial.set(ctx.sweep);
        d.rpmDial.set(ctx.sweep);
        setText(d.speedValue, Math.round(ctx.sweep * SPEED_DIAL.values[SPEED_DIAL.values.length - 1]));
        return;
    }

    d.speedDial.set(d.speedDial.fraction(ctx.speed));
    d.rpmDial.set(d.rpmDial.fraction(ctx.rpm / 1000));
    setText(d.speedValue, Math.round(ctx.speed));
    setText(d.gearValue, derived.gearLabel);
    if (!ctx.slow) return;

    const fuel = fuelFraction(), temp = t.temperature, odo = CONFIG.odometer;
    const avg = (derived.trip > .05 && derived.movingSeconds > 0) ? Math.round(derived.trip / (derived.movingSeconds / 3600)) + ' km/h' : '--- km/h';
    setText(d.totalValue, 'Total ' + Math.round(odo.totalKm + derived.trip) + ' km');
    setText(d.tripValue, (odo.tripKm + derived.trip).toFixed(1) + ' km');
    setText(d.consumptionValue, derived.consumption.toFixed(1) + ' l/100km');
    setText(d.avgSpeedValue, avg);
    setText(d.rangeValue, Math.round(fuel * CONFIG.fuel.rangeMaxKm) + ' km');
    setText(d.temperatureValue, (temp >= 0 ? '+' : '') + temp.toFixed(1) + '°C');
    d.setFuel(fuel, fuel < CONFIG.fuel.lowFraction ? '#ff2a1f' : 'var(--or)');
    d.setTemp((temp - 40) / 60, temp < 70 ? '#6fc3ff' : '#fff');
}

// ---- 4d. DASHBOARD 1 : SUPRA CLASSIC ------------------------------------
const supraClassic = {};

function buildSupraClassic() {
    const g = byId('dashSupraClassic'), c = supraClassic;
    const PX = 190, PY = 262, PR = 180, TX = 975, TY = 262, TR = 145;
    Object.assign(c, { PX, PY, TX, TY });

    // speedometer
    drawFace(g, PX, PY, PR, .05);
    drawScale(g, PX, PY, PR, 140, 245, 0, 180, 20, 5, v => '' + v, PR * .125);
    addText(g, PX + PR * .45, PY + PR * .5, 'km/h', 17, { color: '#c9ced6' });
    drawBox(g, PX - 55, PY - 60, 110, 26);
    drawBox(g, PX - 42, PY + 30, 84, 22);
    c.odo = drawReadout(g, PX, PY - 47, 22, 3);
    c.trip = drawReadout(g, PX, PY + 41, 17, 2);
    c.needleSpeed = createNeedle(g, PX, PY, PR * .8, 4.2, '#ff5a1f');
    drawDisc(g, PX, PY, 15);

    // tachometer
    drawFace(g, TX, TY, TR, .05);
    drawScale(g, TX, TY, TR, 146, 255, 0, 8, 1, .2, v => '' + v, TR * .14, 7);
    addText(g, TX, TY + TR * .46, 'x1000 r/min', 13, { color: '#c9ced6' });
    c.needleRpm = createNeedle(g, TX, TY, TR * .82, 5, '#f28a2a');
    drawDisc(g, TX, TY, 14);

    // small gauges: battery, temperature, fuel
    const gauge = (cx, cy, r, hi, lo, icon) => {
        drawFace(g, cx, cy, r, .05);
        drawScale(g, cx, cy, r, 140, 80, 0, 1, 1, .25, v => v ? hi : lo, r * .3);
        svgEl('use', { href: '#' + icon, transform: `translate(${cx + r * .3},${cy - r * .1}) scale(${r / 55})`, style: '--or:#cfd4db' }, g);
        const needle = createNeedle(g, cx, cy, r * .74, r * .05, '#ff5a1f');
        drawDisc(g, cx, cy, r * .14);
        return f => rotateNode(needle, 140 + 80 * clamp(f, 0, 1), cx, cy);
    };
    c.gaugeBattery = gauge(1190, 100, 48, '+', 'O', 'ic-battery');
    c.gaugeTemp = gauge(1190, 262, 48, 'H', 'C', 'ic-temp');
    c.gaugeFuel = gauge(1190, 424, 48, 'F', 'E', 'ic-fuel');

    // turn signals
    [[470, 1], [744, -1]].forEach(([x, dir]) => {
        const s = svgEl('g', { class: 'signal', transform: `translate(${x},112) scale(${.8 * dir},.8)`, style: '--or:#37c6b0' }, g);
        svgEl('rect', { x: -26, y: -24, width: 52, height: 48, fill: 'transparent' }, s);
        svgEl('path', { class: 'ic-fill', d: 'M-18,0L-2,-14V-6H18V6H-2V14Z' }, s);
    });
}

function updateSupraClassic(ctx) {
    const c = supraClassic, t = telemetryData, odo = CONFIG.odometer, s = ctx.sweep;
    rotateNode(c.needleSpeed, 140 + 245 * Math.min(ctx.speed, 185) / 180, c.PX, c.PY);
    rotateNode(c.needleRpm, 146 + 255 * Math.min(ctx.rpm / 1000, 8.2) / 8, c.TX, c.TY);
    if (!ctx.slow && s == null) return;
    setText(c.odo, String(odo.supraKm + Math.floor(derived.trip)).padStart(6, '0'));
    setText(c.trip, (odo.supraTripKm + derived.trip).toFixed(1).padStart(6, '0'));
    c.gaugeBattery(s ?? t.batteryLevel / 100);
    c.gaugeTemp(s ?? (t.temperature - 40) / 60);
    c.gaugeFuel(s ?? fuelFraction());
}

// ---- 4e. DASHBOARD 2 : 1969 DODGE CHARGER -------------------------------
const charger = {};

function buildCharger() {
    const g = byId('dashChargerClassic'), c = charger;
    const SX = 190, SY = 262, SR = 200, KX = 915, KY = 262, KR = 105;
    Object.assign(c, { SX, SY, KX, KY });

    // speedometer (mph)
    drawFace(g, SX, SY, SR);
    drawScale(g, SX, SY, SR, 160, 235, 0, 140, 10, 5, v => '' + v, SR * .125);
    addText(g, SX, SY + SR * .46, 'MPH', 24, { serif: true });
    drawBox(g, SX - 62, SY - 74, 124, 30);
    drawBox(g, SX - 46, SY + 36, 92, 24);
    c.odo = drawReadout(g, SX, SY - 59, 25, 3);
    c.trip = drawReadout(g, SX, SY + 48, 19, 2);
    c.needleSpeed = createNeedle(g, SX, SY, SR * .8, 5);
    drawHub(g, SX, SY, 18);

    // rallye clock
    drawFace(g, KX, KY, KR);
    drawScale(g, KX, KY, KR, -90, 360, 0, 12, 1, .2, v => v ? '' + Math.round(v) : null, KR * .17);
    addText(g, KX, KY - KR * .4, 'RALLYE', 15, { serif: true });
    addText(g, KX, KY - KR * .22, 'CLOCK', 15, { serif: true });
    c.needleHour = createNeedle(g, KX, KY, KR * .5, 4.5, '#e8eaed');
    c.needleMinute = createNeedle(g, KX, KY, KR * .76, 3, '#e8eaed');
    c.needleSecond = createNeedle(g, KX, KY, KR * .82, 1.6, '#ff2a1f');
    drawHub(g, KX, KY, 7);

    // small gauges: fuel, temperature (°F), tyre pressure, ammeter
    const small = (cx, cy, r, top, bottom, v0, v1, major, minor, labelFn) => {
        drawFace(g, cx, cy, r);
        drawScale(g, cx, cy, r, 200, 140, v0, v1, major, minor, labelFn, r * .2);
        if (top) addText(g, cx, cy - r * .3, top, r * .2, { serif: true });
        if (bottom) addText(g, cx, cy + r * .45, bottom, r * .2, { serif: true });
        const needle = createNeedle(g, cx, cy, r * .72, r * .045);
        drawHub(g, cx, cy, r * .13);
        return f => rotateNode(needle, 200 + 140 * clamp(f, 0, 1), cx, cy);
    };
    c.gaugeFuel = small(1085, 190, 58, 'FUEL', '', 0, 1, 1, .25, v => v ? 'F' : 'E');
    c.gaugeTemp = small(1215, 190, 58, 'TEMP', '°F', 160, 250, 90, 15, v => '' + v);
    c.gaugePsi = small(1085, 335, 58, '', 'PSI', 0, 80, 40, 10, v => '' + v);
    c.gaugeAmmeter = small(1215, 335, 58, 'AMMETER', '', 0, 1, 1, .25, v => v ? '+' : '−');
}

function updateCharger(ctx) {
    const c = charger, t = telemetryData, odo = CONFIG.odometer, s = ctx.sweep;
    rotateNode(c.needleSpeed, 160 + 235 * Math.min(ctx.speed * .621, 146) / 140, c.SX, c.SY);
    if (!ctx.slow && s == null) return;
    setText(c.odo, String(odo.chargerMiles + Math.floor(derived.trip * .621)).padStart(6, '0'));
    setText(c.trip, (odo.chargerTripMiles + derived.trip * .621).toFixed(1).padStart(6, '0'));

    const now = new Date();
    const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
    const minutes = now.getMinutes() + seconds / 60;
    const hours = now.getHours() % 12 + minutes / 60;
    rotateNode(c.needleHour, hours * 30 - 90, c.KX, c.KY);
    rotateNode(c.needleMinute, minutes * 6 - 90, c.KX, c.KY);
    rotateNode(c.needleSecond, seconds * 6 - 90, c.KX, c.KY);

    c.gaugeFuel(s ?? fuelFraction());
    c.gaugeTemp(s ?? (t.temperature * 1.8 + 32 - 160) / 90);
    c.gaugePsi(s ?? (22 + ctx.rpm / 1000 * 9 + (ctx.speed > 2 ? 8 : 0)) / 80);
    c.gaugeAmmeter(s ?? .5 + t.throttle * .12);
}

// ---- 4f. DASHBOARD 3 : FERRARI -------------------------------------------
const ferrari = {};

function buildFerrari() {
    const g = byId('dashFerrari'), f = ferrari;
    const CX = 607, CY = 250, R = 215;
    const GX = 140, GY = 215, GR = 72;                       // g-force crosshair
    const FONT = "font-family:Orbitron,'Arial Black',sans-serif;font-weight:700;";
    Object.assign(f, { CX, CY, GR });

    // 0 at the bottom, clockwise, 10 (x1000 rpm) at 3 o'clock
    const angle = v => (90 + 27 * v) * Math.PI / 180;
    const at = (v, k) => [CX + R * k * Math.cos(angle(v)), CY + R * k * Math.sin(angle(v))];
    const label = (x, y, size, anchor, style) => svgEl('text', { x, y, class: 'txt', 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-size': size, style }, g);

    // bezel with ticks, then the yellow face
    svgEl('circle', { cx: CX, cy: CY, r: R, fill: '#0b0c0e', stroke: '#2a2c31', 'stroke-width': 3 }, g);
    for (let i = 0; i <= 50; i++) {
        const v = i / 5, big = i % 5 === 0, a = at(v, .915), b = at(v, big ? .97 : .95);
        svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: i >= 40 ? '#e5281c' : '#b9bcc2', 'stroke-width': big ? 2.4 : 1.2 }, g);
    }
    svgEl('circle', { cx: CX, cy: CY, r: R * .88, fill: 'url(#gradFerrariFace)' }, g);
    for (let v = 0; v <= 10; v++) {
        const p = at(v, .70);
        label(p[0], p[1], 38, 'middle', `${FONT}fill:${v >= 8 ? '#d6261b' : '#1b1408'}`).textContent = v;
    }

    // hub, needle, gear box
    svgEl('circle', { cx: CX, cy: CY, r: R * .34, fill: 'url(#gradFerrariHub)' }, g);
    f.needle = svgEl('g', {}, g);
    svgEl('polygon', { points: `${CX - R * .12},${CY - 2.2} ${CX + R * .86},${CY - .6} ${CX + R * .86},${CY + .6} ${CX - R * .12},${CY + 2.2}`, fill: '#e5281c' }, f.needle);
    svgEl('circle', { cx: CX, cy: CY, r: 15, fill: '#2a1a0d', stroke: '#e5281c', 'stroke-width': 4 }, g);
    svgEl('rect', { x: CX + 28, y: CY + 26, width: 112, height: 84, rx: 6, fill: '#2b1d10', 'fill-opacity': .88 }, g);
    f.gear = label(CX + 84, CY + 60, 52, 'middle', FONT + 'fill:#fff');
    label(CX + 84, CY + 95, 15, 'middle', 'fill:#d8d2c4;letter-spacing:2px;font-weight:600').textContent = 'AUTO';

    // top row: time, temperature, drive mode
    f.clock = label(330, 42, 24, 'middle', 'fill:#fff;font-weight:600');
    clockNodes.push(f.clock);
    f.temp = label(790, 42, 20, 'middle', 'fill:#fff');
    label(900, 42, 20, 'middle', 'fill:var(--acc);font-weight:600;letter-spacing:1px').textContent = 'SPORT';

    // left: g-force crosshair
    const line = (x1, y1, x2, y2) => svgEl('line', { x1, y1, x2, y2, stroke: '#7d8088', 'stroke-width': 1.2 }, g);
    [GR, GR / 2].forEach(r => svgEl('circle', { cx: GX, cy: GY, r, fill: 'none', stroke: '#7d8088', 'stroke-width': 1.4 }, g));
    line(GX - GR - 14, GY, GX + GR + 14, GY);
    line(GX, GY - GR - 14, GX, GY + GR + 14);
    f.dot = svgEl('circle', { cx: GX, cy: GY, r: 5, fill: '#000', stroke: '#fff', 'stroke-width': 2 }, g);
    const gv = (x, y, anchor, color) => label(x, y, 15, anchor, `fill:${color};font-weight:600`);
    f.gTopPeak = gv(GX, GY - GR - 36, 'middle', '#ff3b30');   f.gTop = gv(GX, GY - GR - 20, 'middle', '#fff');
    f.gBottom = gv(GX, GY + GR + 22, 'middle', '#fff');         f.gBottomPeak = gv(GX, GY + GR + 38, 'middle', '#ff3b30');
    f.gLeftPeak = gv(GX - GR - 18, GY - 9, 'end', '#ff3b30');   f.gLeft = gv(GX - GR - 18, GY + 9, 'end', '#fff');
    f.gRightPeak = gv(GX + GR + 18, GY - 9, 'start', '#ff3b30'); f.gRight = gv(GX + GR + 18, GY + 9, 'start', '#fff');

    // left bottom: speed
    f.speed = label(20, 410, 52, 'start', FONT + 'fill:#fff;font-style:italic');
    label(22, 440, 16, 'start', 'fill:var(--mute);font-weight:600').textContent = 'km/h';

    // bottom: compact digital fuel (battery) gauge
    f.fuel = createFuelArc(g, 590, 497, 28);
}

function updateFerrari(ctx) {
    const f = ferrari, t = telemetryData;
    rotateNode(f.needle, 90 + 27 * clamp(ctx.rpm / 1000, 0, 10.4), f.CX, f.CY);
    setText(f.gear, ctx.speed < .5 ? 'N' : derived.gear);
    setText(f.speed, Math.round(ctx.speed));
    f.fuel(fuelFraction());
    f.dot.setAttribute('cy', 215 - clamp(derived.longG * f.GR / 2, -f.GR * .9, f.GR * .9));
    if (!ctx.slow) return;

    const g1 = v => Math.max(0, v).toFixed(1);
    setText(f.temp, (t.temperature >= 0 ? '+' : '') + t.temperature.toFixed(0) + '°C');
    setText(f.gTop, g1(derived.longG));           setText(f.gTopPeak, g1(derived.peakAccel));
    setText(f.gBottom, g1(-derived.longG));       setText(f.gBottomPeak, g1(derived.peakBrake));
    [f.gLeft, f.gLeftPeak, f.gRight, f.gRightPeak].forEach(n => setText(n, '0.0'));   // no lateral data yet
}

// ---- 4g. DASHBOARD 4 : BMW M3 GTR (racing display) ------------------------
const m3 = {};

// Warning-light icons (24px-ish, drawn around 0,0). Colour comes from --c.
const M3_ICONS = {
    //oil:      '<path class="w-stroke" d="M-12,0H3L7,-4H12M-9,0V9H8V0M-13,-5L-9,0"/><path class="w-fill" d="M13,2Q16,6 13,8Q10,6 13,2Z"/>',
    //battery:  '<rect class="w-stroke" x="-12" y="-7" width="24" height="15" rx="2"/><path class="w-stroke" d="M-7,-7V-10H-3V-7M3,-7V-10H7V-7M-7,1H-3M5,1H9M7,-1V3"/>',
    //brake:    '<circle class="w-stroke" r="9"/><path class="w-stroke" d="M0,-4V1M0,4.2V4.4M-14,-8A15,15 0 0 0 -14,8M14,-8A15,15 0 0 1 14,8"/>',
    //beam:     '<path class="w-fill" transform="translate(-3,0)" d="M3,-10C11,-10 17,-5.5 17,0S11,10 3,10Z"/><path class="w-stroke" d="M-18,-7H-4M-18,0H-4M-18,7H-4"/>',
    //abs:      '<circle class="w-stroke" r="10.5"/><text class="w-fill" font-size="8.5" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif">ABS</text><path class="w-stroke" d="M-16,-8A17,17 0 0 0 -16,8M16,-8A17,17 0 0 1 16,8"/>',
    //engine:   '<path class="w-stroke" d="M-12,-4H-8L-5,-7H-2V-10H6V-7H9L11,-4H13V-1H15V6H13V8H10L7,11H-6L-9,8H-12ZM-12,0H-15M-15,-3V3"/>',
    //traction: '<path class="w-stroke" d="M-9,-1L-6,-8H6L9,-1V6H-9ZM-9,-1H9M-6,2.5H-4M4,2.5H6M-11,11Q-8,8 -5,11T1,11T7,11"/>'
};
const M3_RED = '#ff2a1f', M3_ORANGE = '#ff9f0a', M3_BLUE = '#2d7bff', M3_GREEN = '#2fd25f';
// Which telemetry drives each light (error = key in telemetryData.errors)
const M3_LIGHTS = {
    left:  [{ icon: 'oil', color: M3_RED, error: 'sound' }, { icon: 'battery', color: M3_RED, battery: true }, { icon: 'brake', color: M3_RED }, { icon: 'beam', color: M3_BLUE, error: 'led' }],
    right: [{ icon: 'abs', color: M3_RED, error: 'radio' }, { icon: 'engine', color: M3_ORANGE, error: 'esc' }, { icon: 'traction', color: M3_ORANGE, error: 'imu' }]
};
const M3_LEDS = [M3_GREEN, M3_GREEN, '#ffb020', '#ff8a1f', M3_RED, M3_RED, '#ff5a1f', '#ffb020', M3_GREEN, M3_GREEN];
const M3_BAR = { segments: 40, cx: 440, cy: 458, rOut: 330, rIn: 306, from: 232, to: 308, maxK: 9.4, redFromK: 8 };

function buildM3() {
    const g = byId('dashM3'), f = m3;
    const INK = '#1b2321', NUM = "font-family:Orbitron,'Arial Black',sans-serif;font-weight:700;font-style:italic;";
    svgEl('ellipse', { cx: 1065, cy: 262, rx: 250, ry: 170, fill: 'url(#gradM3Glow)' }, g);      // soft light behind the car render
    const u = svgEl('g', { transform: 'translate(-60,45)' }, g);                                  // the display unit, 880 x 440

    const text = (x, y, size, anchor, style, parent = u) => svgEl('text', { x, y, class: 'txt', 'text-anchor': anchor, 'dominant-baseline': 'central', 'font-size': size, style }, parent);
    const tag = (x, y, str, anchor = 'start') => { text(x, y, 12.5, anchor, `fill:${INK};font-weight:600;letter-spacing:.6px`).textContent = str; };
    const value = (x, y, size, anchor) => text(x, y, size, anchor, NUM + `fill:${INK}`);
    const unit = (x, y, str) => { text(x, y, 12, 'start', `fill:${INK};font-weight:600`).textContent = str; };
    const line = (x1, y1, x2, y2) => svgEl('line', { x1, y1, x2, y2, stroke: INK, 'stroke-opacity': .5, 'stroke-width': 1.2 }, u);

    // ---- housing, knobs, shift lights
    svgEl('path', { d: 'M44,436H836Q880,436 880,392V160Q880,108 826,92C680,32 200,32 54,92Q0,108 0,160V392Q0,436 44,436Z', fill: 'url(#gradM3Bezel)', stroke: '#3a3d44', 'stroke-width': 2 }, u);
    [175, 235, 295, 355].forEach(y => [26, 854].forEach(x => svgEl('circle', { cx: x, cy: y, r: 16, fill: 'url(#gradM3Knob)', stroke: '#2a2c31', 'stroke-width': 1.5 }, u)));
    svgEl('rect', { x: 260, y: 51, width: 360, height: 38, rx: 19, fill: '#08090a', stroke: '#25282c', 'stroke-width': 1.5 }, u);
    f.leds = M3_LEDS.map((color, i) => {
        const d = (i - 4.5) / 4.5;
        return svgEl('circle', { class: 'led', cx: 440 - 148.5 + i * 33, cy: 68 + 6 * d * d, r: 9, style: `--c:${color}` }, u);
    });

    // ---- warning-light columns
    const column = (x, lights) => {
        svgEl('rect', { x, y: 150, width: 60, height: 222, rx: 14, fill: '#0a0b0c', stroke: '#1e2024', 'stroke-width': 1.5 }, u);
        return lights.map((l, i) => {
            const w = svgEl('g', { class: 'warn', transform: `translate(${x + 30},${177 + i * 55})`, style: `--c:${l.color}` }, u);
            w.innerHTML = M3_ICONS[l.icon];
            return { node: w, ...l };
        });
    };
    f.lights = column(60, M3_LIGHTS.left).concat(column(760, M3_LIGHTS.right));
    [-15, 15].forEach((dx, i) => {       // turn signals (tap to toggle)
        const s = svgEl('g', { class: 'signal', transform: `translate(${790 + dx},342) scale(${i ? -.65 : .65},.65)`, style: `--or:${M3_GREEN}` }, u);
        svgEl('rect', { x: -22, y: -22, width: 44, height: 44, fill: 'transparent' }, s);
        svgEl('path', { class: 'ic-fill', d: 'M-18,0L-2,-14V-6H18V6H-2V14Z' }, s);
    });

    // ---- LCD
    svgEl('path', { d: 'M140,344V176Q140,146 172,132C300,98 580,98 708,132Q740,146 740,176V344Q740,372 712,372H168Q140,372 140,344Z', fill: 'url(#gradM3Lcd)', stroke: '#06090a', 'stroke-width': 7 }, u);

    // rpm bar (40 segments on an arc) + numbers 1..9
    const B = M3_BAR, step = (B.to - B.from) / B.segments;
    const pt = (r, a) => [B.cx + r * Math.cos(a * Math.PI / 180), B.cy + r * Math.sin(a * Math.PI / 180)];
    f.segs = Array.from({ length: B.segments }, (_, i) => {
        const a0 = B.from + i * step + .25, a1 = B.from + (i + 1) * step - .25;
        const p = [pt(B.rOut, a0), pt(B.rOut, a1), pt(B.rIn, a1), pt(B.rIn, a0)];
        const red = (i * B.maxK / B.segments) >= B.redFromK - 1e-6;
        const node = svgEl('path', { d: `M${p[0]}A${B.rOut} ${B.rOut} 0 0 1 ${p[1]}L${p[2]}A${B.rIn} ${B.rIn} 0 0 0 ${p[3]}Z` }, u);
        return { node, red, from: i * B.maxK / B.segments + .04, lit: null };
    });
    for (let k = 1; k <= 9; k++) {
        const p = pt(B.rIn - 16, B.from + (k / B.maxK) * (B.to - B.from));
        text(p[0], p[1], 15, 'middle', `fill:${k >= 8 ? '#a8261d' : INK};font-weight:600`).textContent = k;
    }

    // data fields
    tag(152, 240, 'WATER TEMP');  f.water = value(252, 263, 26, 'end');  unit(255, 268, '°C');
    tag(152, 288, 'OIL TEMP');    f.oilTemp = value(252, 311, 26, 'end'); unit(255, 316, '°C');
    tag(612, 240, 'OIL PRESS');   f.oilPress = value(700, 263, 26, 'end'); unit(704, 268, 'bar');
    tag(612, 288, 'FUEL PRESS');  f.fuelPress = value(700, 311, 26, 'end'); unit(704, 316, 'bar');
    f.gear = value(336, 262, 80, 'middle');   tag(336, 305, 'GEAR', 'middle');
    f.speed = value(590, 252, 44, 'end');     tag(590, 282, 'km/h', 'end');
    tag(410, 310, 'RPM');                     f.rpm = value(590, 311, 28, 'end');
    line(280, 226, 280, 324); line(600, 226, 600, 324); line(150, 273, 270, 273); line(610, 273, 730, 273);
    line(140, 327, 740, 327); [230, 410, 590].forEach(x => line(x, 327, x, 372));
    tag(150, 339, 'LAP');        f.lap = value(222, 358, 22, 'end');
    tag(240, 339, 'LAP TIME');   f.lapTime = value(402, 358, 22, 'end');
    tag(420, 339, 'BEST');       f.best = value(582, 358, 22, 'end');
    tag(600, 339, 'FUEL');       f.fuel = value(700, 358, 22, 'end'); unit(704, 363, '%');

    // ---- bottom row: buttons + logo
    const button = (x, label, action) => {
        const b = svgEl('g', { class: 'm3-btn' + (action ? ' hit' : ''), transform: `translate(${x},404)`, 'data-action': action || null }, u);
        svgEl('circle', { r: 21 }, b);
        svgEl('text', { x: 0, y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': label.length > 2 ? 13 : 17 }, b).textContent = label;
    };
    button(150, 'DSP'); button(214, 'MENU'); button(666, '«', 'prev'); button(730, '»', 'next');
    ['#0e9bd8', '#1d3e8f', '#e4002b'].forEach((color, i) => {
        const x = 336 + i * 10;
        svgEl('polygon', { points: `${x},418 ${x + 8},392 ${x + 17},392 ${x + 9},418`, fill: color }, u);
    });
    text(386, 405, 30, 'start', NUM + 'fill:#c9ccd2').textContent = 'M3 GTR';
}

const lapFormat = s => s == null ? '--:--.--' : Math.floor(s / 60) + ':' + (s % 60).toFixed(2).padStart(5, '0');
const numFormat = (v, digits) => v == null ? '--' : Number(v).toFixed(digits);

function updateM3(ctx) {
    const f = m3, t = telemetryData, rpmK = ctx.rpm / 1000, now = performance.now();

    // shift lights: fill left to right, flash at the limit
    const flash = rpmK >= 8.3 && Math.floor(now / 110) % 2 === 0;
    f.leds.forEach((led, i) => led.classList.toggle('on', rpmK >= 4.6 + i * .38 && !(rpmK >= 8.3 && !flash)));

    // rpm bar
    f.segs.forEach(seg => {
        const lit = rpmK >= seg.from;
        if (lit === seg.lit) return;
        seg.lit = lit;
        seg.node.setAttribute('fill', seg.red ? (lit ? '#b3261e' : 'rgba(179,38,30,.2)') : (lit ? '#1b2321' : 'rgba(27,35,33,.09)'));
    });

    setText(f.gear, ctx.speed < .5 ? 'N' : derived.gear);
    setText(f.speed, Math.round(ctx.speed));
    if (!ctx.slow && ctx.sweep == null) return;

    setText(f.rpm, Math.round(ctx.rpm));
    setText(f.water, numFormat(t.temperature, 0));
    setText(f.oilTemp, numFormat(t.oilTemp, 0));
    setText(f.oilPress, numFormat(t.oilPressure, 1));
    setText(f.fuelPress, numFormat(t.fuelPressure, 1));
    setText(f.lap, t.lap != null ? t.lap : derived.lap);
    setText(f.lapTime, lapFormat(t.lapTime != null ? t.lapTime : derived.lapSeconds));
    setText(f.best, lapFormat(t.bestLap != null ? t.bestLap : derived.bestLap));
    setText(f.fuel, Math.round(fuelFraction() * 100));

    // warning lights
    f.lights.forEach(l => l.node.classList.toggle('on', l.battery ? t.batteryLevel < CONFIG.battery.lowPercent : !!(l.error && t.errors[l.error])));
}

// ---- 4h. registry --------------------------------------------------------
// drive = null -> uses the selected drive mode (eco / comfort / sport)
const DASHBOARDS = [
    { id: 'supra-digital', groupId: 'dashSupraDigital',  car: 'supra',   caption: 'TOYOTA SUPRA · DIGITAL', drive: null,                                              build: buildSupraDigital, update: updateSupraDigital },
    { id: 'supra-classic', groupId: 'dashSupraClassic',  car: 'supra',   caption: 'TOYOTA SUPRA · CLASSIC', drive: { power: 30, vmax: 180, up: 4800, dn: 2200 }, sweepMax: { speed: 180, rpm: 8000 },     build: buildSupraClassic, update: updateSupraClassic },
    { id: 'charger',       groupId: 'dashChargerClassic', car: 'charger', caption: '1969 DODGE CHARGER',     drive: { power: 30, vmax: 250, up: 5200, dn: 2600 }, sweepMax: { speed: 235, rpm: 0 },     build: buildCharger,      update: updateCharger },
    { id: 'ferrari', groupId: 'dashFerrari', car: 'ferrari', caption: 'FERRARI F40 · CLUSTER', drive: { power: 34, vmax: 290, up: 7200, dn: 3600 }, sweepMax: { speed: 300, rpm: 10000 }, layout: { dx: 440, dy: -20, hudX: 1047 }, build: buildFerrari, update: updateFerrari },
    { id: 'm3-gtr', groupId: 'dashM3', car: 'm3', caption: 'BMW M3 GTR', drive: { power: 30, vmax: 280, up: 7600, dn: 3800 }, sweepMax: { speed: 280, rpm: 9000 }, layout: { dx: 458, carDy: -34, ctrlDy: 37, carScale: 1.22, spread: 135, chevDy: 103, hud: false }, build: buildM3, update: updateM3 }
];

function setupGauges() {
    DASHBOARDS.forEach(dash => { dash.build(); dash.group = byId(dash.groupId); });
    buildErrorPanel();
}

// =====================================================================
// 5. SIMULATOR  (active while CONFIG.simulator.enabled = true)
//    Automatic drive cycle that writes into telemetryData.
// =====================================================================
const SIM_CYCLE = [          // [seconds, throttle 0..1, brake 0..1]
    [2, 0, 0], [9, 1, 0], [5, .35, 0], [4, 0, 1], [2, 0, 0],
    [14, 1, 0], [6, .5, 0], [8, 0, 1], [3, 0, 0]
];
const simulator = { step: 0, stepTime: 0, throttle: 0, speed: 0, rpm: 750 };

function runSimulator(dt) {
    if (!CONFIG.simulator.enabled) return;
    const sim = simulator, t = telemetryData;

    // live data from the car has priority – follow it and stay idle
    if (performance.now() - liveState.lastTelemetryAt < CONFIG.simulator.liveTimeoutMs) {
        sim.speed = t.speed; sim.rpm = t.rpm; sim.throttle = t.throttle;
        return;
    }

    sim.stepTime += dt;
    if (sim.stepTime >= SIM_CYCLE[sim.step][0]) { sim.stepTime = 0; sim.step = (sim.step + 1) % SIM_CYCLE.length; }
    const gas = SIM_CYCLE[sim.step][1], brake = SIM_CYCLE[sim.step][2];
    const profile = getDriveProfile();

    sim.throttle += (gas - sim.throttle) * (1 - Math.exp(-dt * 6));
    let v = sim.speed;
    v += (sim.throttle * profile.power * (1 - Math.pow(v / profile.vmax, 3)) - brake * 46 - (v > 0 ? 1.2 + v * v / 9000 : 0)) * dt;
    v = Math.max(0, v);
    if (v > profile.vmax) v = Math.max(profile.vmax, v - 30 * dt);
    sim.speed = v;

    const rpmTarget = Math.max(750 + sim.throttle * 3200 * Math.max(0, 1 - v / 18), v * GEAR_RATIOS[derived.gear]);
    sim.rpm += (rpmTarget - sim.rpm) * (1 - Math.exp(-dt * 7));

    const km = v * dt / 3600;
    t.speed = v;
    t.rpm = sim.rpm;
    t.throttle = sim.throttle;
    if (!sim.started) { sim.started = true; t.batteryLevel = CONFIG.simulator.startBattery; }
    t.batteryLevel = Math.max(0, t.batteryLevel - km * (1 + sim.throttle * .6) / CONFIG.fuel.rangeMaxKm * 100);
    t.oilTemp = t.temperature + 14 + sim.throttle * 6;
    t.oilPressure = 1.4 + sim.rpm / 1000 * .55;
    t.fuelPressure = 3.4 + sim.throttle * .3;
    t.temperature = Math.min(90, t.temperature + dt * CONFIG.simulator.warmupPerSecond);
}

// =====================================================================
// 6. INIT / ORIENTATION / FULLSCREEN / CLOCK
// =====================================================================
document.addEventListener('DOMContentLoaded', function () {
    applyThemeFromSettings();
    restoreState();
    initializeDashboard();
    updateClock();
    setInterval(updateClock, 1000);

    showFullscreenOverlay();
    updateDashboard();

    initWebSocket();
});

function initializeDashboard() {
    el.wrap = byId('wrap');
    el.stage = byId('stage');
    el.svg = byId('clusterSvg');
    clockNodes.push(byId('timeDisplay'));

    setupGauges();
    setupCarSwitcher();
    setupSignals();
    applyDashboard();
    checkOrientation();

    window.addEventListener('orientationchange', () => setTimeout(checkOrientation, 100));
    window.addEventListener('resize', checkOrientation);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', checkOrientation);
    if (window.ResizeObserver) new ResizeObserver(checkOrientation).observe(el.wrap);
}

function checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    document.body.classList.toggle('portrait-blocked', CONFIG.orientation === 'overlay' && portrait);
    fitStage();
}

// Scale the 1355-wide stage into the window
let stageScale = 1, stageRotated = false;
function fitStage() {
    const w = el.wrap.clientWidth, h = el.wrap.clientHeight;
    if (!w || !h) return;
    const rotate = CONFIG.orientation === 'rotate' && h > w;
    const aw = rotate ? h : w, ah = rotate ? w : h;
    const stageHeight = Math.round(clamp(DESIGN.width * ah / aw, DESIGN.minHeight, DESIGN.maxHeight));
    const scale = Math.min(aw / DESIGN.width, ah / stageHeight);
    const offsetY = Math.max(0, (stageHeight - DESIGN.buttonBar - DESIGN.contentHeight) / 2);

    stageScale = scale;
    stageRotated = rotate;
    el.stage.style.height = stageHeight + 'px';
    el.stage.style.setProperty('--sh', stageHeight + 'px');
    el.svg.setAttribute('viewBox', `${DESIGN.viewX} ${-offsetY} ${DESIGN.width} ${stageHeight}`);
    el.stage.style.transform = `translate(-50%,-50%) rotate(${rotate ? 90 : 0}deg) scale(${scale})`;
}

function showFullscreenOverlay() {
    const canFullscreen = !!document.documentElement.requestFullscreen;
    if (!CONFIG.fullscreenOverlay || !canFullscreen || document.fullscreenElement) {
        startIntroSweep();
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'fullscreenOverlay';
    overlay.innerHTML = '<h2>Click anywhere to enter Fullscreen</h2><p>(Best dashboard experience)</p>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', () => {
        Promise.resolve(document.documentElement.requestFullscreen())
            .then(() => { dashboardState.isFullscreen = true; })
            .catch(err => console.log('Fullscreen error:', err))
            .finally(() => { overlay.remove(); startIntroSweep(); });   // never leave the user stuck
    });
}
document.addEventListener('fullscreenchange', () => { dashboardState.isFullscreen = !!document.fullscreenElement; });

// Start-up needle test (all dashboards)
const introSweep = { remaining: 0 };
const sweptDashboards = new Set();
function startIntroSweep() {
    introSweep.remaining = CONFIG.introSweepSeconds;
    sweptDashboards.add(dashboardState.current);
}

function updateClock() {
    const now = new Date();
    const time = CONFIG.clock24h
        ? now.toLocaleTimeString('en-US', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
        : (now.getHours() % 12 || 12) + ':' + String(now.getMinutes()).padStart(2, '0');
    clockNodes.forEach(node => setText(node, time));
}

// =====================================================================
// 7. DASHBOARD UPDATE LOOP
// =====================================================================
let lastFrameTime = performance.now(), slowTimer = 0, forceSlowUpdate = true;

function updateDashboard(now = performance.now()) {
    const dt = Math.min(.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    runSimulator(dt);
    updateDerived(dt);

    // text read-outs refresh 10x per second (and immediately after a dashboard switch)
    slowTimer += dt;
    const slow = forceSlowUpdate || slowTimer > .1;
    if (slow) { slowTimer = 0; forceSlowUpdate = false; }

    let sweep = null;
    if (introSweep.remaining > 0) {
        introSweep.remaining -= dt;
        sweep = Math.sin(Math.PI * (1 - Math.max(0, introSweep.remaining) / CONFIG.introSweepSeconds));
    }

    const dash = DASHBOARDS[dashboardState.current];
    let speed = Math.max(0, telemetryData.speed), rpm = Math.max(0, telemetryData.rpm);
    if (sweep != null && dash.sweepMax) { speed = sweep * dash.sweepMax.speed; rpm = sweep * dash.sweepMax.rpm; }   // start-up needle test
    dash.update({ speed, rpm, slow, sweep });

    updateErrorPanel();

    dashboardState.animationFrameId = requestAnimationFrame(updateDashboard);
}

// Gear, trip, consumption … calculated from the telemetry speed
function updateDerived(dt) {
    const speed = Math.max(0, telemetryData.speed), throttle = telemetryData.throttle, profile = getDriveProfile();

    derived.gearCooldown -= dt;
    const gearRpm = speed * GEAR_RATIOS[derived.gear];
    if (derived.gearCooldown <= 0 && speed >= 4) {
        if (gearRpm > profile.up && derived.gear < 8) { derived.gear++; derived.gearCooldown = .7; }
        else if (gearRpm < profile.dn && derived.gear > 1) { derived.gear--; derived.gearCooldown = .7; }
    }
    if (speed < 4) derived.gear = 1;
    derived.gearLabel = (speed < .5 && throttle < .03) ? 'P' : 'D' + derived.gear;

    derived.trip += speed * dt / 3600;
    if (speed > 1) derived.movingSeconds += dt;
    derived.consumption += ((5 + speed * .03 + throttle * 18) - derived.consumption) * Math.min(1, dt * .15);

    // longitudinal g-force from the speed change (+ accelerating / - braking)
    if (dt > 0) {
        const g = (speed - derived.prevSpeed) / dt / 3.6 / 9.81;
        derived.longG += (g - derived.longG) * Math.min(1, dt * 5);
        derived.peakAccel = Math.max(derived.peakAccel, derived.longG);
        derived.peakBrake = Math.max(derived.peakBrake, -derived.longG);
    }
    derived.prevSpeed = speed;

    // lap timer: a lap is CONFIG.lapKm driven
    derived.lapSeconds += dt;
    derived.lapDistance += speed * dt / 3600;
    if (derived.lapDistance >= CONFIG.lapKm) {
        derived.bestLap = derived.bestLap == null ? derived.lapSeconds : Math.min(derived.bestLap, derived.lapSeconds);
        derived.lap++;
        derived.lapSeconds = 0;
        derived.lapDistance = 0;
    }
}

// Small compact fuel / battery gauge: arc + needle + digital percent. Returns update(fraction)
function createFuelArc(parent, x, y, R = 30) {
    const g = svgEl('g', { transform: `translate(${x},${y})` }, parent), arc = `M${-R} 0A${R} ${R} 0 0 1 ${R} 0`, length = Math.PI * R;
    svgEl('path', { d: arc, fill: 'none', stroke: '#3a3d44', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
    const fill = svgEl('path', { d: arc, fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
    [0, .5, 1].forEach(f => {
        const a = Math.PI * (1 + f), cos = Math.cos(a), sin = Math.sin(a);
        svgEl('line', { x1: cos * (R - 9), y1: sin * (R - 9), x2: cos * (R - 4), y2: sin * (R - 4), stroke: '#9aa3b2', 'stroke-width': 1.5 }, g);
    });
    const needle = svgEl('g', {}, g);
    const needleLine = svgEl('line', { x1: 0, y1: 0, x2: R - 8, y2: 0, stroke: '#fff', 'stroke-width': 2.5, 'stroke-linecap': 'round' }, needle);
    svgEl('circle', { cx: 0, cy: 0, r: 3.5, fill: '#fff' }, g);
    [['E', -R], ['F', R]].forEach(([s, lx]) => svgEl('text', { x: lx, y: 15, class: 'txt', 'text-anchor': 'middle', 'font-size': 12, style: 'fill:var(--mute);font-weight:600' }, g).textContent = s);
    const percent = svgEl('text', { x: R + 16, y: 0, class: 'txt', 'text-anchor': 'start', 'dominant-baseline': 'central', 'font-size': 20, style: 'fill:#fff;font-weight:600' }, g);
    let last = -1;
    return f => {
        f = clamp(f, 0, 1);
        if (f === last) return;
        last = f;
        const color = f < CONFIG.fuel.lowFraction ? '#ff3b30' : '#fff';
        fill.setAttribute('stroke-dasharray', f * length + ' 999');
        fill.style.stroke = color;
        needleLine.style.stroke = color;
        needle.setAttribute('transform', `rotate(${180 + 180 * f})`);
        setText(percent, Math.round(f * 100) + '%');
    };
}

// --------------------- ERROR PANEL ---------------------
function buildErrorPanel() {
    const panel = byId('errorPanel'), keys = Object.keys(ERRORS), spacing = 45;
    keys.forEach((key, i) => {
        const chip = svgEl('g', { id: key + 'Error', class: 'err', transform: `translate(${(i - (keys.length - 1) / 2) * spacing},0)` }, panel);
        svgEl('rect', { x: -21, y: -11, width: 42, height: 22, rx: 11 }, chip);
        svgEl('text', { x: 0, y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10 }, chip).textContent = ERRORS[key].chip;
    });
}

function updateErrorPanel() {
    const errors = telemetryData.errors;
    Object.keys(errors).forEach(errorType => {
        const errorElement = byId(errorType + 'Error');
        if (errorElement) {
            if (errors[errorType]) {
                errorElement.classList.add('active');
            } else {
                errorElement.classList.remove('active');
            }
        }
    });
}

// =====================================================================
// 8. CAR SWITCHER
// =====================================================================
function setupCarSwitcher() {
    el.carGroup = byId('carGroup');
    el.carControls = byId('carControls');
    el.swipeHint = byId('swipeHint');
    const carGroup = el.carGroup;
    let drag = null, hintTimer;

    el.hideHint = () => el.swipeHint.setAttribute('opacity', 0);
    el.showHint = ms => {
        el.swipeHint.setAttribute('opacity', 1);
        clearTimeout(hintTimer);
        hintTimer = setTimeout(el.hideHint, ms || 3500);
    };

    const resetCar = () => {
        carGroup.style.transition = 'transform .25s,opacity .25s';
        carGroup.style.transform = '';
        carGroup.style.opacity = 1;
    };

    carGroup.addEventListener('pointerdown', e => {
        if (dashboardState.busy) return;
        drag = { x: e.clientX, y: e.clientY, dx: 0 };
        carGroup.setPointerCapture(e.pointerId);
        el.carControls.classList.add('press');
        carGroup.classList.add('press');
        carGroup.classList.remove('wiggle');
        carGroup.style.transition = 'transform .15s';
        carGroup.style.transform = 'scale(1.05)';
        el.hideHint();
    });

    carGroup.addEventListener('pointermove', e => {
        if (!drag) return;
        drag.dx = (stageRotated ? e.clientY - drag.y : e.clientX - drag.x) / stageScale;
        carGroup.style.transition = 'none';
        carGroup.style.transform = `translate(${drag.dx * .7}px,0) scale(1.05)`;
        carGroup.style.opacity = 1 - Math.min(.45, Math.abs(drag.dx) / 260);
    });

    const endDrag = () => {
        if (!drag) return;
        const dx = drag.dx;
        drag = null;
        el.carControls.classList.remove('press');
        carGroup.classList.remove('press');
        if (Math.abs(dx) > 45) {
            switchDashboard(dx < 0 ? 1 : -1);
        } else {
            resetCar();
            if (Math.abs(dx) < 6) el.showHint();
        }
    };
    ['pointerup', 'pointercancel'].forEach(type => carGroup.addEventListener(type, endDrag));

    byId('chevronLeft').addEventListener('click', () => switchDashboard(-1));
    byId('chevronRight').addEventListener('click', () => switchDashboard(1));
    carGroup.addEventListener('animationend', () => carGroup.classList.remove('wiggle'));

    window.addEventListener('keydown', e => {
        if (e.code === 'ArrowLeft') switchDashboard(-1);
        if (e.code === 'ArrowRight') switchDashboard(1);
    });

    if (!dashboardState.swipeHintSeen) {
        setTimeout(() => { el.showHint(6500); carGroup.classList.add('wiggle'); }, 2400);
    }
}

// Show the selected dashboard (no animation) – used on load and after a switch
function applyDashboard() {
    const index = dashboardState.current, active = DASHBOARDS[index];
    document.body.dataset.dashboard = index;
    DASHBOARDS.forEach((dash, i) => {
        dash.group.setAttribute('opacity', i === index ? 1 : 0);
        dash.group.classList.toggle('active', i === index);
    });
    document.querySelectorAll('[id^="carImage-"]').forEach(img => img.setAttribute('opacity', img.id === 'carImage-' + active.car ? 1 : 0));
    const L = { dx: 0, dy: 0, hudX: 607, hud: true, carScale: 1, spread: 189, chevDy: 0, ...active.layout };   // where the car, switcher and HUD sit
    byId('carAnchor').setAttribute('transform', `translate(${607 + L.dx},${292 + (L.carDy ?? L.dy)}) scale(${L.carScale})`);
    byId('carControls').setAttribute('transform', `translate(${L.dx},${L.ctrlDy ?? L.dy})`);
    byId('chevronLeft').setAttribute('transform', `translate(${607 - L.spread},${292 + L.chevDy})`);
    byId('chevronRight').setAttribute('transform', `translate(${607 + L.spread},${292 + L.chevDy})`);
    byId('hud').setAttribute('transform', `translate(${L.hudX},0)`);
    byId('hud').setAttribute('visibility', L.hud ? 'visible' : 'hidden');
    setText(byId('carCaption'), active.caption);
    DASHBOARDS.forEach((dash, i) => byId('dot' + i).setAttribute('opacity', i === index ? 1 : .3));
    forceSlowUpdate = true;
}

// Animated switch to the next / previous dashboard and remember it
function switchDashboard(dir) {
    if (dashboardState.busy) return;
    dashboardState.busy = true;
    el.hideHint();
    dashboardState.swipeHintSeen = true;

    const carGroup = el.carGroup;
    carGroup.style.transition = 'transform .2s ease-in,opacity .2s';
    carGroup.style.transform = `translate(${-dir * 80}px,0)`;
    carGroup.style.opacity = 0;

    setTimeout(() => {
        dashboardState.current = (dashboardState.current + dir + DASHBOARDS.length) % DASHBOARDS.length;
        store.save({ dashboard: dashboardState.current, swipeHintSeen: true });   // survives a page refresh
        applyDashboard();
        if (!sweptDashboards.has(dashboardState.current)) startIntroSweep();   // every dashboard runs its needle test once

        carGroup.style.transition = 'none';
        carGroup.style.transform = `translate(${dir * 80}px,0)`;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            carGroup.style.transition = 'transform .35s ease-out,opacity .35s';
            carGroup.style.transform = '';
            carGroup.style.opacity = 1;
            setTimeout(() => { dashboardState.busy = false; }, 360);
        }));
    }, 210);
}

// Tap a turn-signal arrow to toggle it
function setupSignals() {
    el.svg.addEventListener('click', e => {
        const signal = e.target.closest('.signal');
        if (signal) signal.classList.toggle('on');
        const action = e.target.closest('[data-action]');
        if (action) switchDashboard(action.dataset.action === 'next' ? 1 : -1);
    });
}

// =====================================================================
// 9. WEBSOCKET
// =====================================================================
let socket;
function initWebSocket() {
    if (!CONFIG.websocket.enabled) return;
    try {
        const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
        socket = new WebSocket(protocol + window.location.host + CONFIG.websocket.path);

        socket.onopen = () => {
            console.log('✅ Connected to car');
            socket.send(JSON.stringify(CONFIG.websocket.hello));
        };

        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'battery_status') {
                    telemetryData.batteryLevel = Number(data.percent);
                } else {
                    liveState.lastTelemetryAt = performance.now();
                    applyTelemetry(data);
                }
            } catch (e) {
                console.log('WS parse error:', e);
            }
        };

        socket.onerror = (err) => console.log('WS error:', err);
        socket.onclose = () => {
            console.log('WS closed, retrying...');
            setTimeout(initWebSocket, CONFIG.websocket.retryMs);   // reconnecting
        };
    } catch (e) {
        console.log('WebSocket init failed:', e);
    }
}

function sendWsMessage(type, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type, ...payload }));
    }
}

// =====================================================================
// 10. THEME + EXPORT
// =====================================================================
function applyThemeFromSettings() {
    try {
        const saved = localStorage.getItem('carSettings');
        const theme = saved ? (JSON.parse(saved).theme || 'dark') : 'dark';
        let background;

        switch (theme) {
            case 'light':
                background = CONFIG.themes.light;
                break;
            case 'system':
                background = window.matchMedia('(prefers-color-scheme: dark)').matches ? CONFIG.themes.systemDark : CONFIG.themes.systemLight;
                break;
            case 'dark':
            default:
                background = CONFIG.themes.dark;
        }
        document.documentElement.style.setProperty('--bg', background);
    } catch (e) {
        console.log('Theme apply error:', e);
    }
}

window.telemetryData = telemetryData;
window.sendWsMessage = sendWsMessage;
