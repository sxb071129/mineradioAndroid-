#include <android/log.h>
#include <cstdlib>
#include <cstring>
#include <jni.h>
#include <string>
#include <vector>

#include "node.h"

namespace {
constexpr const char* LOG_TAG = "MineradioNode";

std::string JStringToString(JNIEnv* env, jstring value) {
    if (!value) return "";
    const char* raw = env->GetStringUTFChars(value, nullptr);
    std::string result = raw ? raw : "";
    if (raw) env->ReleaseStringUTFChars(value, raw);
    return result;
}

std::vector<std::string> ToStringVector(JNIEnv* env, jobjectArray values) {
    std::vector<std::string> result;
    if (!values) return result;
    const jsize length = env->GetArrayLength(values);
    result.reserve(static_cast<size_t>(length));
    for (jsize i = 0; i < length; ++i) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(values, i));
        result.push_back(JStringToString(env, item));
        env->DeleteLocalRef(item);
    }
    return result;
}

void ApplyEnvironment(JNIEnv* env, jobjectArray environment) {
    for (const auto& entry : ToStringVector(env, environment)) {
        const size_t separator = entry.find('=');
        if (separator == std::string::npos || separator == 0) continue;
        const std::string key = entry.substr(0, separator);
        const std::string value = entry.substr(separator + 1);
        setenv(key.c_str(), value.c_str(), 1);
    }
}
}

extern "C" JNIEXPORT jint JNICALL
Java_com_mineradio_android_NodeRuntime_startNodeWithArguments(
    JNIEnv* env,
    jclass,
    jobjectArray arguments,
    jobjectArray environment) {
    ApplyEnvironment(env, environment);

    std::vector<std::string> args = ToStringVector(env, arguments);
    if (args.empty()) args.push_back("node");

    std::vector<char*> argv;
    argv.reserve(args.size());
    for (std::string& arg : args) {
        argv.push_back(arg.data());
    }

    __android_log_print(ANDROID_LOG_INFO, LOG_TAG, "Starting Node.js with %d args", static_cast<int>(argv.size()));
    return node::Start(static_cast<int>(argv.size()), argv.data());
}
