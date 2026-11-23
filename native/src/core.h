#ifndef SCREENREC_CORE_H
#define SCREENREC_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SCREENREC_VERSION "2.0.0"

typedef enum {
    SR_PROTO_HEADLESS = 0,
    SR_PROTO_X11      = 1,
    SR_PROTO_WAYLAND  = 2
} SrDisplayProtocol;

typedef enum {
    SR_SOURCE_SCREEN  = 0,
    SR_SOURCE_WINDOW  = 1,
    SR_SOURCE_BROWSER = 2
} SrCaptureSource;

typedef struct {
    SrDisplayProtocol protocol;
    bool              has_xwayland;
    char              label[96];
    char              backend[96];
    char              detected_via[160];
    char              wayland_display[64];
    char              x11_display[64];
    char              desktop_env[64];
    char              distro_name[96];
} SrDisplayInfo;

typedef struct {
    unsigned long window_id;
    char          title[192];
    char          wm_class[96];
    int           x;
    int           y;
    int           width;
    int           height;
    bool          is_browser;
} SrWindowEntry;

typedef struct {
    bool pulse_available;
    char default_sink_monitor[192];
    char default_mic_source[192];
    char audio_server_label[96];
    char mic_sources[16][192];
    char mic_labels[16][192];
    int  mic_count;
} SrAudioDevices;

typedef struct {
    SrCaptureSource source;
    bool            system_audio;
    bool            mic_audio;
    bool            include_cursor;
    const char     *sink_monitor;
    const char     *mic_source;
    const char     *x11_display;
    int             capture_x;
    int             capture_y;
    int             capture_width;
    int             capture_height;
    const char     *output_mp4_path;
} SrCaptureConfig;

typedef struct {
    char toggle_record[32];
    char toggle_pause[32];
    char toggle_sys_audio[32];
    char toggle_mic[32];
    char toggle_cursor[32];
} SrShortcutConfig;

/* Pure display-detection logic (unit-testable with synthetic inputs) */
void sr_detect_display_from_inputs(
    const char    *xdg_session_type,
    const char    *wayland_display,
    const char    *x11_display,
    const char    *xdg_current_desktop,
    const char    *first_wayland_socket,
    const char    *first_x11_socket,
    const char    *logind_type,
    SrDisplayInfo *out_info
);

/*
 * GUI-safe startup bootstrap:
 * 1. Drops root privileges to logged-in desktop user if launched via privileged GUI installer.
 * 2. Probes compositor sockets (/run/user/$UID/wayland-*, /tmp/.X11-unix/X*),
 *    systemctl --user, and loginctl when launched from GUI menus with no CLI env vars.
 * 3. Exports WAYLAND_DISPLAY / DISPLAY / XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS.
 */
void sr_bootstrap_gui_environment(bool allow_privilege_drop, SrDisplayInfo *out_info);

/* Discovers PulseAudio / PipeWire-Pulse sink monitor and microphone sources */
void sr_probe_audio_devices(SrAudioDevices *out_audio);

/* Enumerates visible top-level X11 windows (including browser windows) using libX11 */
int sr_list_x11_windows(const char *display_name, SrWindowEntry *out_list, int max_entries);

/* Builds NULL-terminated argv array for X11 FFmpeg MP4 capture (caller frees with sr_free_argv) */
char **sr_build_x11_ffmpeg_argv(const SrCaptureConfig *cfg);

/* Builds NULL-terminated argv array for Wayland FFmpeg MP4 muxing from pipe:0 Matroska video */
char **sr_build_wayland_ffmpeg_argv(const SrCaptureConfig *cfg);

void sr_free_argv(char **argv);

/* Formats default timestamped MP4 filename, e.g. screenrec-screen-2026-11-22-192000.mp4 */
void sr_make_default_mp4_filename(SrCaptureSource source, char *buf, size_t buf_size);

/* Formats elapsed seconds as MM:SS or HH:MM:SS */
void sr_format_duration(int total_seconds, char *buf, size_t buf_size);

/* Shortcut config defaults, load, save, and conflict validation */
void sr_shortcuts_init_defaults(SrShortcutConfig *cfg);
bool sr_shortcuts_validate_no_duplicates(const SrShortcutConfig *cfg);
bool sr_shortcuts_load(const char *path, SrShortcutConfig *cfg);
bool sr_shortcuts_save(const char *path, const SrShortcutConfig *cfg);

#endif /* SCREENREC_CORE_H */
