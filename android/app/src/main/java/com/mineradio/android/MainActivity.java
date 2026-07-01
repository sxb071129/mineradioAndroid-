package com.mineradio.android;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {
    private static final int NODE_PORT = 3000;
    private static final int REQUEST_LOGIN = 9101;
    private static final int REQUEST_IMPORT_JSON = 9102;
    private static boolean nodeStarted = false;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private WebView webView;
    private TextView statusView;
    private ProgressBar progressBar;
    private String pendingLoginToken;
    private String pendingImportToken;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        webView = new WebView(this);
        configureWebView(webView);
        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT));

        progressBar = new ProgressBar(this);
        FrameLayout.LayoutParams progressParams = new FrameLayout.LayoutParams(dp(46), dp(46), Gravity.CENTER);
        root.addView(progressBar, progressParams);

        statusView = new TextView(this);
        statusView.setTextColor(Color.rgb(212, 235, 238));
        statusView.setTextSize(14);
        statusView.setGravity(Gravity.CENTER);
        statusView.setText("Starting Mineradio...");
        FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.CENTER_HORIZONTAL | Gravity.CENTER_VERTICAL);
        statusParams.topMargin = dp(72);
        root.addView(statusView, statusParams);

        setContentView(root);
        startNodeAndLoad();
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.setWebViewClient(new WebViewClient());
        view.setWebChromeClient(new WebChromeClient());
        view.addJavascriptInterface(new AndroidBridge(), "MineradioAndroid");
    }

    private void startNodeAndLoad() {
        executor.execute(() -> {
            try {
                File projectDir = prepareNodeProject();
                writeAndroidEnvironment(projectDir);
                if (!nodeStarted) {
                    nodeStarted = true;
                    Thread nodeThread = new Thread(() -> {
                        try {
                            String[] args = new String[] {
                                "node",
                                new File(projectDir, "android-main.js").getAbsolutePath()
                            };
                            String[] env = nodeEnvironment(projectDir);
                            int exitCode = NodeRuntime.startNodeWithArguments(args, env);
                            if (exitCode != 0) {
                                showStartupFailure("Node service exited with code " + exitCode);
                            }
                        } catch (Throwable error) {
                            nodeStarted = false;
                            showStartupFailure(error.getMessage());
                        }
                    }, "Mineradio-Node");
                    nodeThread.setDaemon(false);
                    nodeThread.start();
                }
                waitForServer();
                runOnUiThread(() -> {
                    progressBar.setVisibility(android.view.View.GONE);
                    statusView.setVisibility(android.view.View.GONE);
                    webView.loadUrl("http://127.0.0.1:" + NODE_PORT + "/");
                });
            } catch (Throwable e) {
                showStartupFailure(e.getMessage());
            }
        });
    }

    private void showStartupFailure(String message) {
        String detail = message == null || message.isEmpty() ? "unknown error" : message;
        runOnUiThread(() -> statusView.setText("Startup failed: " + detail));
    }

    private File prepareNodeProject() throws Exception {
        File target = new File(getFilesDir(), "nodejs-project");
        String expectedVersion = readAssetText("nodejs-project.version").trim();
        File stamp = new File(target, ".android_asset_version");
        String currentVersion = stamp.exists() ? readFileText(stamp).trim() : "";
        if (!target.exists() || !expectedVersion.equals(currentVersion)) {
            deleteRecursively(target);
            if (!target.mkdirs() && !target.isDirectory()) {
                throw new IllegalStateException("Cannot create Node project directory");
            }
            unzipAsset("nodejs-project.zip", target);
            writeFileText(stamp, expectedVersion);
        }
        return target;
    }

    private void writeAndroidEnvironment(File projectDir) throws Exception {
        JSONObject env = new JSONObject();
        env.put("MINERADIO_ANDROID", "1");
        env.put("NODE_ENV", "production");
        env.put("HOST", "127.0.0.1");
        env.put("PORT", String.valueOf(NODE_PORT));
        env.put("TMPDIR", getCacheDir().getAbsolutePath());
        env.put("COOKIE_FILE", new File(getFilesDir(), ".cookie").getAbsolutePath());
        env.put("QQ_COOKIE_FILE", new File(getFilesDir(), ".qq-cookie").getAbsolutePath());
        env.put("KUGOU_COOKIE_FILE", new File(getFilesDir(), ".kugou-cookie").getAbsolutePath());
        env.put("MINERADIO_UPDATE_DIR", new File(getFilesDir(), "updates").getAbsolutePath());
        env.put("MINERADIO_UPDATE_DOWNLOAD_DIR", new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "updates").getAbsolutePath());
        env.put("MINERADIO_BEAT_CACHE_DIR", new File(getFilesDir(), "beatmaps").getAbsolutePath());
        writeFileText(new File(projectDir, "android-env.json"), env.toString());
    }

    private String[] nodeEnvironment(File projectDir) {
        List<String> env = new ArrayList<>();
        env.add("NODE_ENV=production");
        env.add("MINERADIO_ANDROID=1");
        env.add("HOME=" + getFilesDir().getAbsolutePath());
        env.add("TMPDIR=" + getCacheDir().getAbsolutePath());
        env.add("NODE_PATH=" + new File(projectDir, "node_modules").getAbsolutePath());
        env.add("UV_THREADPOOL_SIZE=8");
        return env.toArray(new String[0]);
    }

    private void waitForServer() throws Exception {
        long deadline = System.currentTimeMillis() + 45000L;
        Exception last = null;
        while (System.currentTimeMillis() < deadline) {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL("http://127.0.0.1:" + NODE_PORT + "/api/app/version").openConnection();
                conn.setConnectTimeout(1000);
                conn.setReadTimeout(1000);
                if (conn.getResponseCode() == 200) {
                    conn.disconnect();
                    return;
                }
                conn.disconnect();
            } catch (Exception e) {
                last = e;
            }
            Thread.sleep(350);
        }
        throw new IllegalStateException(last == null ? "Node service did not start" : last.getMessage());
    }

    private void unzipAsset(String assetName, File targetDir) throws Exception {
        String canonicalRoot = targetDir.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(getAssets().open(assetName)))) {
            ZipEntry entry;
            byte[] buffer = new byte[8192];
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(targetDir, entry.getName());
                String canonicalOut = out.getCanonicalPath();
                if (!canonicalOut.startsWith(canonicalRoot)) {
                    throw new IllegalStateException("Bad zip entry: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    if (!out.mkdirs() && !out.isDirectory()) {
                        throw new IllegalStateException("Cannot create directory " + out);
                    }
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.mkdirs() && !parent.isDirectory()) {
                    throw new IllegalStateException("Cannot create directory " + parent);
                }
                try (FileOutputStream output = new FileOutputStream(out)) {
                    int read;
                    while ((read = zip.read(buffer)) != -1) output.write(buffer, 0, read);
                }
            }
        }
    }

    private String readAssetText(String name) throws Exception {
        try (InputStream input = getAssets().open(name)) {
            return readStreamText(input);
        }
    }

    private static String readStreamText(InputStream input) throws Exception {
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (builder.length() > 0) builder.append('\n');
                builder.append(line);
            }
        }
        return builder.toString();
    }

    private static String readFileText(File file) throws Exception {
        try (InputStream input = new java.io.FileInputStream(file)) {
            return readStreamText(input);
        }
    }

    private static void writeFileText(File file, String text) throws Exception {
        File parent = file.getParentFile();
        if (parent != null && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IllegalStateException("Cannot create directory " + parent);
        }
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursively(child);
            }
        }
        file.delete();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private JSONObject ok() {
        JSONObject object = new JSONObject();
        try { object.put("ok", true); } catch (Exception ignored) {}
        return object;
    }

    private JSONObject error(String message) {
        JSONObject object = new JSONObject();
        try {
            object.put("ok", false);
            object.put("error", message);
        } catch (Exception ignored) {}
        return object;
    }

    private void resolvePromise(String token, JSONObject payload) {
        if (token == null || token.trim().isEmpty() || webView == null) return;
        runOnUiThread(() -> webView.evaluateJavascript(
            "window.__mineradioAndroidResolve && window.__mineradioAndroidResolve("
                + JSONObject.quote(token) + "," + payload.toString() + ");",
            null));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_LOGIN) {
            String token = pendingLoginToken;
            pendingLoginToken = null;
            JSONObject payload = new JSONObject();
            try {
                String raw = data == null ? "" : data.getStringExtra(LoginActivity.EXTRA_RESULT_JSON);
                payload = raw == null || raw.isEmpty() ? new JSONObject() : new JSONObject(raw);
                if (!payload.has("ok")) payload.put("ok", resultCode == RESULT_OK);
            } catch (Exception e) {
                payload = error(e.getMessage());
            }
            resolvePromise(token, payload);
            return;
        }
        if (requestCode == REQUEST_IMPORT_JSON) {
            String token = pendingImportToken;
            pendingImportToken = null;
            JSONObject payload = new JSONObject();
            try {
                if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                    payload.put("ok", false);
                    payload.put("error", "IMPORT_CANCELLED");
                } else {
                    Uri uri = data.getData();
                    String text;
                    try (InputStream input = getContentResolver().openInputStream(uri)) {
                        text = input == null ? "" : readStreamText(input);
                    }
                    payload.put("ok", true);
                    payload.put("text", text);
                    payload.put("filePath", uri.toString());
                }
            } catch (Exception e) {
                payload = error(e.getMessage());
            }
            resolvePromise(token, payload);
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        executor.shutdownNow();
        super.onDestroy();
    }

    public final class AndroidBridge {
        @JavascriptInterface
        public String getState(String json) {
            JSONObject object = ok();
            try {
                object.put("isAndroid", true);
                object.put("isDesktop", true);
                object.put("isMaximized", true);
                object.put("isFullScreen", true);
                object.put("isNativeFullScreen", true);
                object.put("isPrimaryDisplay", true);
                object.put("hasDisplayOnLeft", false);
            } catch (Exception ignored) {}
            return object.toString();
        }

        @JavascriptInterface
        public String openLogin(String json) {
            try {
                JSONObject request = new JSONObject(json == null ? "{}" : json);
                String token = request.optString("token");
                String provider = request.optString("provider", "netease");
                runOnUiThread(() -> {
                    pendingLoginToken = token;
                    Intent intent = new Intent(MainActivity.this, LoginActivity.class);
                    intent.putExtra(LoginActivity.EXTRA_PROVIDER, provider);
                    startActivityForResult(intent, REQUEST_LOGIN);
                });
                return ok().toString();
            } catch (Exception e) {
                return error(e.getMessage()).toString();
            }
        }

        @JavascriptInterface
        public String clearLogin(String json) {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            return ok().toString();
        }

        @JavascriptInterface
        public String exportJsonFile(String json) {
            try {
                JSONObject request = new JSONObject(json == null ? "{}" : json);
                String token = request.optString("token");
                String defaultName = sanitizeFileName(request.optString("defaultName", "mineradio-export.json"));
                if (!defaultName.toLowerCase(Locale.ROOT).endsWith(".json")) defaultName += ".json";
                String text = request.optString("text", "{}");
                File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Mineradio");
                if (!dir.mkdirs() && !dir.isDirectory()) throw new IllegalStateException("Cannot create export directory");
                File target = uniqueFile(dir, defaultName);
                writeFileText(target, text);
                JSONObject payload = ok();
                payload.put("filePath", target.getAbsolutePath());
                resolvePromise(token, payload);
                return ok().toString();
            } catch (Exception e) {
                return error(e.getMessage()).toString();
            }
        }

        @JavascriptInterface
        public String importJsonFile(String json) {
            try {
                JSONObject request = new JSONObject(json == null ? "{}" : json);
                String token = request.optString("token");
                runOnUiThread(() -> {
                    pendingImportToken = token;
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                    startActivityForResult(intent, REQUEST_IMPORT_JSON);
                });
                return ok().toString();
            } catch (Exception e) {
                return error(e.getMessage()).toString();
            }
        }

        @JavascriptInterface
        public String openExternal(String json) {
            try {
                JSONObject request = new JSONObject(json == null ? "{}" : json);
                String url = request.optString("url");
                if (url == null || url.trim().isEmpty()) return error("MISSING_URL").toString();
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(intent);
                return ok().toString();
            } catch (Exception e) {
                return error(e.getMessage()).toString();
            }
        }

        @JavascriptInterface
        public String openUpdateInstaller(String json) {
            return error("APK_INSTALL_MUST_BE_DONE_BY_ANDROID_PACKAGE_INSTALLER").toString();
        }

        @JavascriptInterface
        public String restartApp(String json) {
            runOnUiThread(() -> {
                Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                }
            });
            return ok().toString();
        }

        @JavascriptInterface
        public String openAppSettings(String json) {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            return ok().toString();
        }
    }

    private static String sanitizeFileName(String raw) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty()) name = "mineradio-export.json";
        return name.replaceAll("[\\\\/:*?\"<>|]+", "_");
    }

    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        if (!file.exists()) return file;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 1000; i++) {
            File candidate = new File(dir, base + "-" + i + ext);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }
}
