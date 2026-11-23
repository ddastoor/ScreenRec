#include "../src/core.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static bool argv_contains_pair(char **argv, const char *flag, const char *val) {
    for (int i = 0; argv[i] != NULL && argv[i + 1] != NULL; i++) {
        if (strcmp(argv[i], flag) == 0 && strcmp(argv[i + 1], val) == 0) {
            return true;
        }
    }
    return false;
}

static bool argv_contains(char **argv, const char *token) {
    for (int i = 0; argv[i] != NULL; i++) {
        if (strcmp(argv[i], token) == 0) return true;
    }
    return false;
}

static void test_display_detection(void) {
    SrDisplayInfo info;

    /* 1. Wayland + XWayland prioritizes Wayland over DISPLAY=:0 */
    sr_detect_display_from_inputs(
        "wayland",
        "wayland-0",
        ":0",
        "KDE",
        "/run/user/1000/wayland-0",
        "/tmp/.X11-unix/X0",
        "",
        &info
    );
    assert(info.protocol == SR_PROTO_WAYLAND);
    assert(info.has_xwayland == true);
    assert(strcmp(info.label, "Wayland (with XWayland)") == 0);

    /* 2. GUI-launched with NO CLI env vars: detects Wayland purely from /run/user/1000/wayland-0 */
    sr_detect_display_from_inputs(
        "",
        "",
        "",
        "",
        "/run/user/1000/wayland-0",
        "/tmp/.X11-unix/X0",
        "",
        &info
    );
    assert(info.protocol == SR_PROTO_WAYLAND);
    assert(info.has_xwayland == true);
    assert(strstr(info.detected_via, "Wayland socket") != NULL);
    assert(strcmp(info.wayland_display, "wayland-0") == 0);
    assert(strcmp(info.x11_display, ":0") == 0);

    /* 3. GUI-launched with NO CLI env vars on X11: detects X11 from /tmp/.X11-unix/X0 */
    sr_detect_display_from_inputs(
        "",
        "",
        "",
        "XFCE",
        "",
        "/tmp/.X11-unix/X0",
        "",
        &info
    );
    assert(info.protocol == SR_PROTO_X11);
    assert(info.has_xwayland == false);
    assert(strcmp(info.x11_display, ":0") == 0);
    assert(strstr(info.detected_via, "X11 socket") != NULL);

    /* 4. Headless when neither Wayland nor X11 exists */
    sr_detect_display_from_inputs("", "", "", "", "", "", "", &info);
    assert(info.protocol == SR_PROTO_HEADLESS);
}

static void test_ffmpeg_argv_builders(void) {
    /* X11 with System Audio + Mic + Cursor Hidden + Odd Dimensions */
    SrCaptureConfig x11_cfg = {
        .source          = SR_SOURCE_WINDOW,
        .system_audio    = true,
        .mic_audio       = true,
        .include_cursor  = false,
        .sink_monitor    = "alsa_output.analog.monitor",
        .mic_source      = "alsa_input.usb_mic",
        .x11_display     = ":0",
        .capture_x       = 100,
        .capture_y       = 50,
        .capture_width   = 1365, /* odd -> clamped to 1364 */
        .capture_height  = 769,  /* odd -> clamped to 768  */
        .output_mp4_path = "/tmp/out.mp4",
    };

    char **x11_argv = sr_build_x11_ffmpeg_argv(&x11_cfg);
    assert(x11_argv != NULL);
    assert(argv_contains_pair(x11_argv, "-f", "x11grab"));
    assert(argv_contains_pair(x11_argv, "-draw_mouse", "0"));
    assert(argv_contains_pair(x11_argv, "-video_size", "1364x768"));
    assert(argv_contains_pair(x11_argv, "-i", ":0+100,50"));
    assert(argv_contains_pair(x11_argv, "-i", "alsa_output.analog.monitor"));
    assert(argv_contains_pair(x11_argv, "-i", "alsa_input.usb_mic"));
    assert(argv_contains_pair(x11_argv, "-c:v", "libx264"));
    assert(argv_contains_pair(x11_argv, "-c:a", "aac"));
    assert(argv_contains_pair(x11_argv, "-movflags", "+faststart"));
    sr_free_argv(x11_argv);

    /* Wayland silent video with cursor included */
    SrCaptureConfig wl_cfg = {
        .source          = SR_SOURCE_SCREEN,
        .system_audio    = false,
        .mic_audio       = false,
        .include_cursor  = true,
        .output_mp4_path = "/tmp/wl.mp4",
    };
    char **wl_argv = sr_build_wayland_ffmpeg_argv(&wl_cfg);
    assert(wl_argv != NULL);
    assert(argv_contains_pair(wl_argv, "-f", "matroska"));
    assert(argv_contains_pair(wl_argv, "-i", "pipe:0"));
    assert(argv_contains(wl_argv, "-an"));
    sr_free_argv(wl_argv);
}

static void test_shortcuts_and_formatting(void) {
    char dur[32];
    sr_format_duration(65, dur, sizeof(dur));
    assert(strcmp(dur, "01:05") == 0);
    sr_format_duration(3661, dur, sizeof(dur));
    assert(strcmp(dur, "01:01:01") == 0);

    char fname[128];
    sr_make_default_mp4_filename(SR_SOURCE_BROWSER, fname, sizeof(fname));
    assert(strncmp(fname, "screenrec-tab-", 14) == 0);
    assert(strstr(fname, ".mp4") != NULL);

    SrShortcutConfig sc;
    sr_shortcuts_init_defaults(&sc);
    assert(sr_shortcuts_validate_no_duplicates(&sc) == true);

    char tmp_conf[128];
    snprintf(tmp_conf, sizeof(tmp_conf), "/tmp/sr-shortcuts-test-%u.conf", (unsigned)getpid());
    snprintf(sc.toggle_record, sizeof(sc.toggle_record), "F8");
    assert(sr_shortcuts_save(tmp_conf, &sc) == true);

    SrShortcutConfig loaded;
    assert(sr_shortcuts_load(tmp_conf, &loaded) == true);
    assert(strcmp(loaded.toggle_record, "F8") == 0);
    unlink(tmp_conf);

    /* Duplicate bindings must be rejected */
    snprintf(loaded.toggle_pause, sizeof(loaded.toggle_pause), "f8");
    assert(sr_shortcuts_validate_no_duplicates(&loaded) == false);
}

int main(void) {
    test_display_detection();
    test_ffmpeg_argv_builders();
    test_shortcuts_and_formatting();
    printf("[OK] All native C11 core unit tests passed.\n");
    return 0;
}
