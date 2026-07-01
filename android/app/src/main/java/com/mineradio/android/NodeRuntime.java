package com.mineradio.android;

final class NodeRuntime {
    static {
        System.loadLibrary("native-lib");
    }

    private NodeRuntime() {
    }

    static native int startNodeWithArguments(String[] arguments, String[] environment);
}
