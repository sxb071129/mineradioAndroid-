cmake_minimum_required(VERSION 3.22.1)
project(mineradio_node)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}/../../../libnode/include/node")

find_library(log-lib log)
target_link_libraries(native-lib node ${log-lib})
