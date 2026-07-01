package com.mineradio.android;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.Set;

public class LoginActivity extends Activity {
    public static final String EXTRA_PROVIDER = "provider";
    public static final String EXTRA_RESULT_JSON = "resultJson";

    private String provider;
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        provider = getIntent().getStringExtra(EXTRA_PROVIDER);
        if (provider == null) provider = "netease";

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(5, 6, 8));

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(14), dp(8), dp(10), dp(8));
        bar.setBackgroundColor(Color.rgb(5, 6, 8));

        TextView title = new TextView(this);
        title.setText(loginTitle(provider));
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        title.setGravity(Gravity.CENTER_VERTICAL);
        bar.addView(title, new LinearLayout.LayoutParams(0, dp(42), 1f));

        Button done = new Button(this);
        done.setText("Done");
        done.setAllCaps(false);
        done.setOnClickListener(v -> finishWithCookies(true));
        bar.addView(done, new LinearLayout.LayoutParams(dp(96), dp(42)));

        Button cancel = new Button(this);
        cancel.setText("Close");
        cancel.setAllCaps(false);
        cancel.setOnClickListener(v -> finishWithCookies(false));
        bar.addView(cancel, new LinearLayout.LayoutParams(dp(96), dp(42)));

        webView = new WebView(this);
        configureWebView(webView);
        webView.loadUrl(loginUrl(provider));

        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(58)));
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.setWebViewClient(new WebViewClient());
    }

    private void finishWithCookies(boolean ok) {
        CookieManager.getInstance().flush();
        JSONObject result = new JSONObject();
        try {
            result.put("ok", ok);
            result.put("provider", provider);
            result.put("cookie", ok ? collectCookies(provider) : "");
            result.put("partial", false);
            if (!ok) result.put("error", "LOGIN_CANCELLED");
        } catch (Exception ignored) {
        }
        Intent data = new Intent();
        data.putExtra(EXTRA_RESULT_JSON, result.toString());
        setResult(ok ? RESULT_OK : RESULT_CANCELED, data);
        finish();
    }

    private static String collectCookies(String provider) {
        CookieManager manager = CookieManager.getInstance();
        Set<String> parts = new LinkedHashSet<>();
        for (String url : cookieUrls(provider)) {
            String raw = manager.getCookie(url);
            if (raw == null || raw.trim().isEmpty()) continue;
            String[] chunks = raw.split(";");
            for (String chunk : chunks) {
                String item = chunk.trim();
                if (!item.isEmpty()) parts.add(item);
            }
        }
        StringBuilder joined = new StringBuilder();
        for (String part : parts) {
            if (joined.length() > 0) joined.append("; ");
            joined.append(part);
        }
        return joined.toString();
    }

    private static String[] cookieUrls(String provider) {
        if ("qq".equals(provider)) {
            return new String[] {
                "https://y.qq.com", "https://u.y.qq.com", "https://c.y.qq.com",
                "https://i.y.qq.com", "https://qq.com"
            };
        }
        if ("kugou".equals(provider)) {
            return new String[] {
                "https://www.kugou.com", "https://kugou.com", "https://wwwapi.kugou.com",
                "https://login-user.kugou.com"
            };
        }
        return new String[] {
            "https://music.163.com", "https://interface.music.163.com", "https://163.com"
        };
    }

    private static String loginUrl(String provider) {
        if ("qq".equals(provider)) return "https://y.qq.com/n/ryqq/profile";
        if ("kugou".equals(provider)) return "https://www.kugou.com/";
        return "https://music.163.com/#/login";
    }

    private static String loginTitle(String provider) {
        if ("qq".equals(provider)) return "QQ Music login";
        if ("kugou".equals(provider)) return "Kugou Music login";
        return "Netease Cloud Music login";
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
