package com.mindfs.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LauncherNodeSync")
public class LauncherNodeSyncPlugin extends Plugin {
    private static final String PREFS_NAME = "mindfs_launcher_node_sync";
    private static final String KEY_PENDING_RELAY_NODES = "pending_relay_nodes";
    private static final String KEY_LAUNCHER_NODES = "launcher_nodes";

    @PluginMethod
    public void storeRelayNodes(PluginCall call) {
        JSArray nodes = call.getArray("nodes");
        if (nodes == null) {
            call.reject("nodes is required");
            return;
        }
        storeRelayNodesJSON(getContext(), nodes.toString());

        JSObject result = new JSObject();
        result.put("stored", true);
        result.put("count", nodes.length());
        call.resolve(result);
    }

    @PluginMethod
    public void consumeRelayNodes(PluginCall call) {
        String raw = prefs(getContext()).getString(KEY_PENDING_RELAY_NODES, "");
        prefs(getContext())
            .edit()
            .remove(KEY_PENDING_RELAY_NODES)
            .apply();

        JSArray nodes = parseNodesJSON(raw);

        JSObject result = new JSObject();
        result.put("nodes", nodes);
        result.put("count", nodes.length());
        call.resolve(result);
    }

    @PluginMethod
    public void getLauncherNodes(PluginCall call) {
        JSArray nodes = parseNodesJSON(prefs(getContext()).getString(KEY_LAUNCHER_NODES, ""));

        JSObject result = new JSObject();
        result.put("nodes", nodes);
        result.put("count", nodes.length());
        call.resolve(result);
    }

    @PluginMethod
    public void setLauncherNodes(PluginCall call) {
        JSArray nodes = call.getArray("nodes");
        if (nodes == null) {
            call.reject("nodes is required");
            return;
        }

        prefs(getContext())
            .edit()
            .putString(KEY_LAUNCHER_NODES, nodes.toString())
            .apply();

        JSObject result = new JSObject();
        result.put("stored", true);
        result.put("count", nodes.length());
        call.resolve(result);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static void storeRelayNodesJSON(Context context, String rawJSON) {
        prefs(context)
            .edit()
            .putString(KEY_PENDING_RELAY_NODES, rawJSON == null ? "" : rawJSON)
            .apply();
    }

    private static JSArray parseNodesJSON(String raw) {
        if (raw != null && !raw.trim().isEmpty()) {
            try {
                return new JSArray(raw);
            } catch (Exception ignored) {
            }
        }
        return new JSArray();
    }
}
