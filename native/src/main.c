#define _GNU_SOURCE
#include "core.h"
#include "wayland_portal.h"

#include <errno.h>
#include <fcntl.h>
#include <gdk/gdk.h>
#include <gtk/gtk.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef GDK_WINDOWING_X11
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <gdk/gdkx.h>
#endif

#ifdef GDK_WINDOWING_WAYLAND
#include <gdk/gdkwayland.h>
#endif

typedef enum {
    APP_STATE_IDLE = 0,
    APP_STATE_RECORDING,
    APP_STATE_PAUSED,
    APP_STATE_FINALIZING
} AppRecordingState;

typedef struct {
    SrDisplayInfo     display_info;
    SrAudioDevices    audio_info;
    SrShortcutConfig  shortcuts;
    char              shortcuts_path[512];

    AppRecordingState state;
    SrCaptureSource   source;
    bool              system_audio;
    bool              mic_audio;
    bool              include_cursor;

    SrWindowEntry     windows[64];
    int               window_count;
    int               filtered_indices[64];
    int               filtered_count;

    /* Active capture subprocesses */
    GPid              ffmpeg_pid;
    int               ffmpeg_stdin_fd;
    GPid              gst_pid;
    int               elapsed_seconds;
    guint             timer_source_id;
    char              temp_mp4_path[512];
    char              last_saved_mp4_path[512];

    /* GTK3 Widgets */
    GtkWidget        *window;
    GtkWidget        *header_bar;
    GtkWidget        *timer_label;
    GtkWidget        *display_badge_label;
    GtkWidget        *display_detail_label;

    GtkWidget        *btn_src_screen;
    GtkWidget        *btn_src_window;
    GtkWidget        *btn_src_browser;
    GtkWidget        *window_picker_box;
    GtkWidget        *window_combo;
    GtkWidget        *window_refresh_btn;

    GtkWidget        *chk_sys_audio;
    GtkWidget        *chk_mic_audio;
    GtkWidget        *mic_combo;
    GtkWidget        *chk_cursor;

    GtkWidget        *lbl_sys_shortcut;
    GtkWidget        *lbl_mic_shortcut;
    GtkWidget        *lbl_cur_shortcut;

    GtkWidget        *btn_record;
    GtkWidget        *btn_pause;
    GtkWidget        *status_label;
    GtkWidget        *saved_box;
    GtkWidget        *saved_path_label;

#ifdef GDK_WINDOWING_X11
    int               x11_keycode_record;
    unsigned int      x11_mods_record;
    int               x11_keycode_pause;
    unsigned int      x11_mods_pause;
#endif
} ScreenRecApp;

static void start_or_stop_recording(ScreenRecApp *app);
static void pause_or_resume_recording(ScreenRecApp *app);
static void update_ui_state(ScreenRecApp *app);

static const char *APP_CSS =
    "window { background-color: #f8fafc; }"
    ".sr-card { background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; }"
    ".sr-banner { background-color: #ffffff; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 14px; }"
    ".sr-title { font-weight: 700; font-size: 15px; color: #0f172a; }"
    ".sr-section { font-weight: 700; font-size: 12px; color: #334155; }"
    ".sr-muted { font-size: 12px; color: #64748b; }"
    ".sr-mono { font-family: monospace; font-weight: 700; font-size: 13px; color: #0f172a; }"
    ".sr-kbd { font-family: monospace; font-size: 11px; color: #334155; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 4px; padding: 2px 7px; }"
    ".sr-seg-btn { background-image: none; background-color: #f1f5f9; color: #334155; font-weight: 600; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 7px; padding: 7px 10px; }"
    ".sr-seg-btn:hover { background-color: #e2e8f0; }"
    ".sr-seg-btn:checked { background-image: none; background-color: #0f172a; color: #ffffff; border-color: #0f172a; }"
    ".sr-rec-btn { background-image: none; background-color: #dc2626; color: #ffffff; font-weight: 700; border-radius: 8px; padding: 9px 14px; border: none; }"
    ".sr-rec-btn:hover { background-color: #b91c1c; }"
    ".sr-stop-btn { background-image: none; background-color: #0f172a; color: #ffffff; font-weight: 700; border-radius: 8px; padding: 9px 14px; border: none; }";

static void format_accel_human(const char *accel, char *out, size_t out_sz) {
    guint keyval = 0;
    GdkModifierType mods = 0;
    gtk_accelerator_parse(accel ? accel : "", &keyval, &mods);
    if (keyval != 0) {
        gchar *pretty = gtk_accelerator_get_label(keyval, mods);
        if (pretty && pretty[0]) {
            snprintf(out, out_sz, "%s", pretty);
            g_free(pretty);
            return;
        }
        g_free(pretty);
    }
    snprintf(out, out_sz, "%s", accel ? accel : "");
}

static void on_main_window_destroy(GtkWidget *w, gpointer data) {
    (void)w;
    (void)data;
    if (gtk_main_level() > 0) {
        gtk_main_quit();
    }
}

static void ensure_parent_dir(const char *filepath) {
    char tmp[512];
    snprintf(tmp, sizeof(tmp), "%s", filepath);
    char *slash = strrchr(tmp, '/');
    if (slash && slash != tmp) {
        *slash = '\0';
        g_mkdir_with_parents(tmp, 0755);
    }
}

static void refine_display_with_gdk(SrDisplayInfo *info) {
    GdkDisplay *dpy = gdk_display_get_default();
    if (!dpy || !info) return;

#ifdef GDK_WINDOWING_WAYLAND
    if (GDK_IS_WAYLAND_DISPLAY(dpy)) {
        info->protocol = SR_PROTO_WAYLAND;
        snprintf(
            info->label,
            sizeof(info->label),
            "%s",
            info->has_xwayland ? "Wayland (with XWayland)" : "Wayland"
        );
        snprintf(info->backend, sizeof(info->backend), "xdg-desktop-portal + PipeWire ScreenCast");
        if (!info->detected_via[0]) {
            snprintf(info->detected_via, sizeof(info->detected_via), "GDK Wayland Display Backend");
        }
        return;
    }
#endif

#ifdef GDK_WINDOWING_X11
    if (GDK_IS_X11_DISPLAY(dpy)) {
        /* Note: if running under XWayland while Wayland socket is active, keep Wayland protocol
           so portal ScreenCast captures the real Wayland compositor instead of black X11 root! */
        if (info->protocol != SR_PROTO_WAYLAND) {
            info->protocol = SR_PROTO_X11;
            snprintf(info->label, sizeof(info->label), "X11 (X.Org Server)");
            snprintf(info->backend, sizeof(info->backend), "X11 Composite / FFmpeg x11grab");
            const char *gname = gdk_display_get_name(dpy);
            if (gname && gname[0]) {
                snprintf(info->x11_display, sizeof(info->x11_display), "%s", gname);
            }
        }
    }
#endif
}

static void refresh_x11_window_list(ScreenRecApp *app) {
    gtk_combo_box_text_remove_all(GTK_COMBO_BOX_TEXT(app->window_combo));
    app->filtered_count = 0;

    if (app->display_info.protocol != SR_PROTO_X11) {
        gtk_combo_box_text_append_text(
            GTK_COMBO_BOX_TEXT(app->window_combo),
            "Native OS Wayland Window Picker opens on Start"
        );
        gtk_combo_box_set_active(GTK_COMBO_BOX(app->window_combo), 0);
        return;
    }

    app->window_count = sr_list_x11_windows(app->display_info.x11_display, app->windows, 64);
    bool want_browser_only = (app->source == SR_SOURCE_BROWSER);

    for (int i = 0; i < app->window_count; i++) {
        if (want_browser_only && !app->windows[i].is_browser) continue;
        char entry[320];
        snprintf(
            entry,
            sizeof(entry),
            "%s (%dx%d)",
            app->windows[i].title,
            app->windows[i].width,
            app->windows[i].height
        );
        gtk_combo_box_text_append_text(GTK_COMBO_BOX_TEXT(app->window_combo), entry);
        app->filtered_indices[app->filtered_count++] = i;
    }

    if (app->filtered_count == 0) {
        gtk_combo_box_text_append_text(
            GTK_COMBO_BOX_TEXT(app->window_combo),
            want_browser_only
                ? "Click browser window interactively on Start (xwininfo)"
                : "Click application window interactively on Start (xwininfo)"
        );
    }
    gtk_combo_box_set_active(GTK_COMBO_BOX(app->window_combo), 0);
}

static bool pick_window_via_xwininfo(int *out_x, int *out_y, int *out_w, int *out_h) {
    FILE *fp = popen("xwininfo 2>/dev/null", "r");
    if (!fp) return false;
    int ax = 0, ay = 0, w = 0, h = 0;
    char line[256];
    while (fgets(line, sizeof(line), fp)) {
        sscanf(line, " Absolute upper-left X: %d", &ax);
        sscanf(line, " Absolute upper-left Y: %d", &ay);
        sscanf(line, " Width: %d", &w);
        sscanf(line, " Height: %d", &h);
    }
    int rc = pclose(fp);
    if (rc != 0 || w < 16 || h < 16) return false;
    *out_x = ax < 0 ? 0 : ax;
    *out_y = ay < 0 ? 0 : ay;
    *out_w = (w / 2) * 2;
    *out_h = (h / 2) * 2;
    return true;
}

static void get_primary_screen_geometry(int *out_w, int *out_h) {
    *out_w = 1280;
    *out_h = 720;
    GdkDisplay *dpy = gdk_display_get_default();
    if (!dpy) return;
    int n_mons = gdk_display_get_n_monitors(dpy);
    if (n_mons > 0) {
        GdkMonitor *mon = gdk_display_get_monitor(dpy, 0);
        if (mon) {
            GdkRectangle rect;
            gdk_monitor_get_geometry(mon, &rect);
            int scale = gdk_monitor_get_scale_factor(mon);
            if (scale < 1) scale = 1;
            if (rect.width > 0 && rect.height > 0) {
                *out_w = ((rect.width * scale) / 2) * 2;
                *out_h = ((rect.height * scale) / 2) * 2;
            }
        }
    }
}

#ifdef GDK_WINDOWING_X11
static int ignore_x11_grab_error(Display *d, XErrorEvent *e) {
    (void)d;
    (void)e;
    return 0;
}

static unsigned int gdk_mods_to_x11_mask(GdkModifierType mods) {
    unsigned int mask = 0;
    if (mods & GDK_SHIFT_MASK) mask |= ShiftMask;
    if (mods & GDK_CONTROL_MASK) mask |= ControlMask;
    if (mods & GDK_MOD1_MASK) mask |= Mod1Mask;
    if (mods & GDK_SUPER_MASK) mask |= Mod4Mask;
    return mask;
}

static void register_x11_global_hotkeys(ScreenRecApp *app) {
    GdkDisplay *gdpy = gdk_display_get_default();
    if (!gdpy || !GDK_IS_X11_DISPLAY(gdpy)) return;

    Display *xdpy = GDK_DISPLAY_XDISPLAY(gdpy);
    Window xroot  = DefaultRootWindow(xdpy);

    int (*old_handler)(Display *, XErrorEvent *) = XSetErrorHandler(ignore_x11_grab_error);
    XUngrabKey(xdpy, AnyKey, AnyModifier, xroot);

    const unsigned int lock_variants[4] = { 0, LockMask, Mod2Mask, LockMask | Mod2Mask };

    guint keyval = 0;
    GdkModifierType mods = 0;
    gtk_accelerator_parse(app->shortcuts.toggle_record, &keyval, &mods);
    if (keyval != 0) {
        app->x11_keycode_record = XKeysymToKeycode(xdpy, (KeySym)keyval);
        app->x11_mods_record    = gdk_mods_to_x11_mask(mods);
        if (app->x11_keycode_record != 0) {
            for (int i = 0; i < 4; i++) {
                XGrabKey(
                    xdpy,
                    app->x11_keycode_record,
                    app->x11_mods_record | lock_variants[i],
                    xroot,
                    True,
                    GrabModeAsync,
                    GrabModeAsync
                );
            }
        }
    }

    gtk_accelerator_parse(app->shortcuts.toggle_pause, &keyval, &mods);
    if (keyval != 0) {
        app->x11_keycode_pause = XKeysymToKeycode(xdpy, (KeySym)keyval);
        app->x11_mods_pause    = gdk_mods_to_x11_mask(mods);
        if (app->x11_keycode_pause != 0) {
            for (int i = 0; i < 4; i++) {
                XGrabKey(
                    xdpy,
                    app->x11_keycode_pause,
                    app->x11_mods_pause | lock_variants[i],
                    xroot,
                    True,
                    GrabModeAsync,
                    GrabModeAsync
                );
            }
        }
    }

    XSync(xdpy, False);
    XSetErrorHandler(old_handler);
}

static GdkFilterReturn x11_root_event_filter(GdkXEvent *xevent, GdkEvent *event, gpointer data) {
    (void)event;
    ScreenRecApp *app = (ScreenRecApp *)data;
    XEvent *xe = (XEvent *)xevent;
    if (xe->type == KeyPress) {
        unsigned int clean_state = xe->xkey.state & ~(LockMask | Mod2Mask);
        if (app->x11_keycode_record != 0 &&
            (int)xe->xkey.keycode == app->x11_keycode_record &&
            clean_state == app->x11_mods_record) {
            start_or_stop_recording(app);
            return GDK_FILTER_REMOVE;
        }
        if (app->x11_keycode_pause != 0 &&
            (int)xe->xkey.keycode == app->x11_keycode_pause &&
            clean_state == app->x11_mods_pause) {
            pause_or_resume_recording(app);
            return GDK_FILTER_REMOVE;
        }
    }
    return GDK_FILTER_CONTINUE;
}
#endif

static bool copy_file_bytes(const char *src, const char *dst) {
    int in_fd = open(src, O_RDONLY);
    if (in_fd < 0) return false;
    int out_fd = open(dst, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out_fd < 0) {
        close(in_fd);
        return false;
    }
    char buf[65536];
    ssize_t n;
    bool ok = true;
    while ((n = read(in_fd, buf, sizeof(buf))) > 0) {
        ssize_t written = 0;
        while (written < n) {
            ssize_t w = write(out_fd, buf + written, (size_t)(n - written));
            if (w <= 0) {
                ok = false;
                break;
            }
            written += w;
        }
        if (!ok) break;
    }
    close(in_fd);
    close(out_fd);
    return ok;
}

static void prompt_save_mp4_dialog(ScreenRecApp *app) {
    struct stat st;
    if (stat(app->temp_mp4_path, &st) != 0 || st.st_size < 64) {
        gtk_label_set_text(
            GTK_LABEL(app->status_label),
            "Recording ended before MP4 video frames could be written."
        );
        unlink(app->temp_mp4_path);
        return;
    }

    char default_name[128];
    sr_make_default_mp4_filename(app->source, default_name, sizeof(default_name));

    const char *videos_dir = g_get_user_special_dir(G_USER_DIRECTORY_VIDEOS);
    char fallback_videos[512];
    if (!videos_dir || !videos_dir[0]) {
        snprintf(fallback_videos, sizeof(fallback_videos), "%s/Videos", g_get_home_dir());
        g_mkdir_with_parents(fallback_videos, 0755);
        videos_dir = fallback_videos;
    }

    GtkFileChooserNative *native = gtk_file_chooser_native_new(
        "Save MP4 Screen Recording",
        GTK_WINDOW(app->window),
        GTK_FILE_CHOOSER_ACTION_SAVE,
        "_Save MP4",
        "_Cancel"
    );
    GtkFileChooser *chooser = GTK_FILE_CHOOSER(native);
    gtk_file_chooser_set_do_overwrite_confirmation(chooser, TRUE);
    gtk_file_chooser_set_current_folder(chooser, videos_dir);
    gtk_file_chooser_set_current_name(chooser, default_name);

    GtkFileFilter *mp4_filter = gtk_file_filter_new();
    gtk_file_filter_set_name(mp4_filter, "MP4 Video (*.mp4)");
    gtk_file_filter_add_pattern(mp4_filter, "*.mp4");
    gtk_file_chooser_add_filter(chooser, mp4_filter);

    gint res = gtk_native_dialog_run(GTK_NATIVE_DIALOG(native));
    if (res == GTK_RESPONSE_ACCEPT) {
        char *chosen = gtk_file_chooser_get_filename(chooser);
        if (chosen) {
            char final_path[512];
            if (g_str_has_suffix(chosen, ".mp4") || g_str_has_suffix(chosen, ".MP4")) {
                snprintf(final_path, sizeof(final_path), "%s", chosen);
            } else {
                snprintf(final_path, sizeof(final_path), "%s.mp4", chosen);
            }
            g_free(chosen);

            if (rename(app->temp_mp4_path, final_path) != 0) {
                if (copy_file_bytes(app->temp_mp4_path, final_path)) {
                    unlink(app->temp_mp4_path);
                }
            }

            snprintf(app->last_saved_mp4_path, sizeof(app->last_saved_mp4_path), "%s", final_path);
            char msg[600];
            snprintf(msg, sizeof(msg), "Saved MP4: %s", final_path);
            gtk_label_set_text(GTK_LABEL(app->saved_path_label), msg);
            gtk_widget_show_all(app->saved_box);
            gtk_label_set_text(GTK_LABEL(app->status_label), "MP4 file saved successfully.");
        }
    } else {
        unlink(app->temp_mp4_path);
        gtk_label_set_text(GTK_LABEL(app->status_label), "Recording discarded.");
    }

    g_object_unref(native);
}

static void on_ffmpeg_child_exited(GPid pid, gint status, gpointer user_data) {
    (void)status;
    ScreenRecApp *app = (ScreenRecApp *)user_data;
    g_spawn_close_pid(pid);

    if (app->timer_source_id != 0) {
        g_source_remove(app->timer_source_id);
        app->timer_source_id = 0;
    }
    if (app->ffmpeg_stdin_fd >= 0) {
        close(app->ffmpeg_stdin_fd);
        app->ffmpeg_stdin_fd = -1;
    }
    if (app->gst_pid > 0) {
        kill(app->gst_pid, SIGTERM);
        g_spawn_close_pid(app->gst_pid);
        app->gst_pid = 0;
    }
    app->ffmpeg_pid = 0;

    bool was_stopping = (app->state == APP_STATE_FINALIZING);
    app->state = APP_STATE_IDLE;
    update_ui_state(app);

    if (was_stopping) {
        prompt_save_mp4_dialog(app);
    } else {
        struct stat st;
        if (stat(app->temp_mp4_path, &st) == 0 && st.st_size >= 64) {
            prompt_save_mp4_dialog(app);
        } else {
            gtk_label_set_text(
                GTK_LABEL(app->status_label),
                "Capture process stopped unexpectedly. Check FFmpeg / audio device availability."
            );
        }
    }
}

static gboolean on_recording_tick(gpointer user_data) {
    ScreenRecApp *app = (ScreenRecApp *)user_data;
    if (app->state == APP_STATE_RECORDING) {
        app->elapsed_seconds++;
        char tbuf[32];
        sr_format_duration(app->elapsed_seconds, tbuf, sizeof(tbuf));
        gtk_label_set_text(GTK_LABEL(app->timer_label), tbuf);
    }
    return G_SOURCE_CONTINUE;
}

static void child_leave_fds_open(gpointer user_data) {
    (void)user_data;
    /* Allows inherited PipeWire fd to stay open across fork/exec for gst-launch-1.0 */
}

static bool start_wayland_recording(ScreenRecApp *app, const SrCaptureConfig *cfg) {
    gtk_label_set_text(
        GTK_LABEL(app->status_label),
        "Select the screen or window in the system Wayland dialog..."
    );
    while (gtk_events_pending()) gtk_main_iteration();

    SrWaylandPortalStream portal = {0};
    if (!sr_wayland_portal_open_screencast(app->source, app->include_cursor, &portal)) {
        gtk_label_set_text(GTK_LABEL(app->status_label), portal.error_message);
        return false;
    }

    /* Clear FD_CLOEXEC on portal.pipewire_fd so gst-launch-1.0 inherits it */
    int flags = fcntl(portal.pipewire_fd, F_GETFD);
    if (flags >= 0) {
        fcntl(portal.pipewire_fd, F_SETFD, flags & ~FD_CLOEXEC);
    }

    char fd_arg[32], path_arg[32];
    snprintf(fd_arg, sizeof(fd_arg), "fd=%d", portal.pipewire_fd);
    snprintf(path_arg, sizeof(path_arg), "path=%u", portal.node_id);

    char *gst_argv[] = {
        "gst-launch-1.0",
        "-q",
        "pipewiresrc",
        fd_arg,
        path_arg,
        "do-timestamp=true",
        "!",
        "videoconvert",
        "!",
        "video/x-raw,format=BGRx",
        "!",
        "queue",
        "!",
        "matroskamux",
        "streamable=true",
        "!",
        "fdsink",
        "fd=1",
        NULL
    };

    gint gst_stdout_fd = -1;
    GError *err = NULL;
    gboolean gst_ok = g_spawn_async_with_pipes(
        NULL,
        gst_argv,
        NULL,
        G_SPAWN_SEARCH_PATH | G_SPAWN_LEAVE_DESCRIPTORS_OPEN,
        child_leave_fds_open,
        NULL,
        &app->gst_pid,
        NULL,
        &gst_stdout_fd,
        NULL,
        &err
    );
    close(portal.pipewire_fd);

    if (!gst_ok) {
        char msg[320];
        snprintf(
            msg,
            sizeof(msg),
            "Failed to launch PipeWire GStreamer bridge (gst-launch-1.0): %s",
            err ? err->message : "missing gstreamer1.0-pipewire"
        );
        gtk_label_set_text(GTK_LABEL(app->status_label), msg);
        if (err) g_error_free(err);
        return false;
    }

    char **ff_argv = sr_build_wayland_ffmpeg_argv(cfg);
    gboolean ff_ok = g_spawn_async_with_fds(
        NULL,
        ff_argv,
        NULL,
        G_SPAWN_SEARCH_PATH | G_SPAWN_DO_NOT_REAP_CHILD,
        NULL,
        NULL,
        &app->ffmpeg_pid,
        gst_stdout_fd,
        -1,
        -1,
        &err
    );
    sr_free_argv(ff_argv);
    close(gst_stdout_fd);

    if (!ff_ok) {
        kill(app->gst_pid, SIGTERM);
        g_spawn_close_pid(app->gst_pid);
        app->gst_pid = 0;
        char msg[320];
        snprintf(msg, sizeof(msg), "Failed to launch FFmpeg MP4 encoder: %s", err ? err->message : "error");
        gtk_label_set_text(GTK_LABEL(app->status_label), msg);
        if (err) g_error_free(err);
        return false;
    }

    app->ffmpeg_stdin_fd = -1;
    g_child_watch_add(app->ffmpeg_pid, on_ffmpeg_child_exited, app);
    return true;
}

static bool start_x11_recording(ScreenRecApp *app, SrCaptureConfig *cfg) {
    if (app->source == SR_SOURCE_SCREEN) {
        cfg->capture_x = 0;
        cfg->capture_y = 0;
        get_primary_screen_geometry(&cfg->capture_width, &cfg->capture_height);
    } else {
        int sel = gtk_combo_box_get_active(GTK_COMBO_BOX(app->window_combo));
        if (sel >= 0 && sel < app->filtered_count) {
            const SrWindowEntry *w = &app->windows[app->filtered_indices[sel]];
            cfg->capture_x      = w->x;
            cfg->capture_y      = w->y;
            cfg->capture_width  = w->width;
            cfg->capture_height = w->height;
        } else {
            gtk_label_set_text(
                GTK_LABEL(app->status_label),
                "Click on the target window on your screen to start recording..."
            );
            while (gtk_events_pending()) gtk_main_iteration();
            if (!pick_window_via_xwininfo(
                    &cfg->capture_x,
                    &cfg->capture_y,
                    &cfg->capture_width,
                    &cfg->capture_height
                )) {
                gtk_label_set_text(GTK_LABEL(app->status_label), "Window selection canceled.");
                return false;
            }
        }
    }

    char **ff_argv = sr_build_x11_ffmpeg_argv(cfg);
    GError *err = NULL;
    gint stdin_fd = -1;
    gboolean ok = g_spawn_async_with_pipes(
        NULL,
        ff_argv,
        NULL,
        G_SPAWN_SEARCH_PATH | G_SPAWN_DO_NOT_REAP_CHILD,
        NULL,
        NULL,
        &app->ffmpeg_pid,
        &stdin_fd,
        NULL,
        NULL,
        &err
    );
    sr_free_argv(ff_argv);

    if (!ok) {
        char msg[320];
        snprintf(msg, sizeof(msg), "Failed to launch FFmpeg: %s", err ? err->message : "error");
        gtk_label_set_text(GTK_LABEL(app->status_label), msg);
        if (err) g_error_free(err);
        return false;
    }

    app->ffmpeg_stdin_fd = stdin_fd;
    g_child_watch_add(app->ffmpeg_pid, on_ffmpeg_child_exited, app);
    return true;
}

static void start_or_stop_recording(ScreenRecApp *app) {
    if (app->state == APP_STATE_FINALIZING) return;

    if (app->state == APP_STATE_RECORDING || app->state == APP_STATE_PAUSED) {
        if (app->state == APP_STATE_PAUSED) {
            if (app->gst_pid > 0) kill(app->gst_pid, SIGCONT);
            if (app->ffmpeg_pid > 0) kill(app->ffmpeg_pid, SIGCONT);
        }

        app->state = APP_STATE_FINALIZING;
        update_ui_state(app);
        gtk_label_set_text(GTK_LABEL(app->status_label), "Finalizing H.264/AAC MP4 container...");

        if (app->gst_pid > 0) {
            /* Closing PipeWire GStreamer stream sends clean EOF on pipe:0 to FFmpeg */
            kill(app->gst_pid, SIGINT);
        } else if (app->ffmpeg_stdin_fd >= 0) {
            ssize_t _w = write(app->ffmpeg_stdin_fd, "q\n", 2);
            (void)_w;
            close(app->ffmpeg_stdin_fd);
            app->ffmpeg_stdin_fd = -1;
        } else if (app->ffmpeg_pid > 0) {
            kill(app->ffmpeg_pid, SIGINT);
        }
        return;
    }

    /* Start a new recording */
    snprintf(
        app->temp_mp4_path,
        sizeof(app->temp_mp4_path),
        "%s/screenrec-active-%u.mp4",
        g_get_tmp_dir(),
        (unsigned)getpid()
    );
    unlink(app->temp_mp4_path);

    int mic_idx = gtk_combo_box_get_active(GTK_COMBO_BOX(app->mic_combo));
    const char *chosen_mic = (mic_idx >= 0 && mic_idx < app->audio_info.mic_count)
                                 ? app->audio_info.mic_sources[mic_idx]
                                 : app->audio_info.default_mic_source;

    bool use_sys_audio = app->system_audio && app->audio_info.pulse_available;
    bool use_mic_audio = app->mic_audio && app->audio_info.pulse_available;

    SrCaptureConfig cfg = {
        .source          = app->source,
        .system_audio    = use_sys_audio,
        .mic_audio       = use_mic_audio,
        .include_cursor  = app->include_cursor,
        .sink_monitor    = app->audio_info.default_sink_monitor,
        .mic_source      = chosen_mic,
        .x11_display     = app->display_info.x11_display[0] ? app->display_info.x11_display : ":0",
        .output_mp4_path = app->temp_mp4_path,
    };

    bool started = false;
    if (app->display_info.protocol == SR_PROTO_WAYLAND) {
        started = start_wayland_recording(app, &cfg);
    } else {
        started = start_x11_recording(app, &cfg);
    }

    if (started) {
        app->state           = APP_STATE_RECORDING;
        app->elapsed_seconds = 0;
        gtk_label_set_text(GTK_LABEL(app->timer_label), "00:00");
        gtk_widget_hide(app->saved_box);
        app->timer_source_id = g_timeout_add_seconds(1, on_recording_tick, app);
        if ((app->system_audio || app->mic_audio) && !app->audio_info.pulse_available) {
            gtk_label_set_text(
                GTK_LABEL(app->status_label),
                "Recording video (no PulseAudio/PipeWire daemon active) — press F9 to Stop & Save MP4."
            );
        } else {
            gtk_label_set_text(
                GTK_LABEL(app->status_label),
                "Recording in progress — press F9 to Stop & Save MP4, or F10 to Pause."
            );
        }
        update_ui_state(app);
    }
}

static void pause_or_resume_recording(ScreenRecApp *app) {
    if (app->state == APP_STATE_RECORDING) {
        if (app->gst_pid > 0) kill(app->gst_pid, SIGSTOP);
        if (app->ffmpeg_pid > 0) kill(app->ffmpeg_pid, SIGSTOP);
        app->state = APP_STATE_PAUSED;
        gtk_label_set_text(GTK_LABEL(app->status_label), "Recording paused — press F10 to Resume.");
        update_ui_state(app);
    } else if (app->state == APP_STATE_PAUSED) {
        if (app->ffmpeg_pid > 0) kill(app->ffmpeg_pid, SIGCONT);
        if (app->gst_pid > 0) kill(app->gst_pid, SIGCONT);
        app->state = APP_STATE_RECORDING;
        gtk_label_set_text(GTK_LABEL(app->status_label), "Recording resumed.");
        update_ui_state(app);
    }
}

static void update_ui_state(ScreenRecApp *app) {
    bool idle = (app->state == APP_STATE_IDLE);
    bool busy_final = (app->state == APP_STATE_FINALIZING);

    gtk_widget_set_sensitive(app->btn_src_screen, idle);
    gtk_widget_set_sensitive(app->btn_src_window, idle);
    gtk_widget_set_sensitive(app->btn_src_browser, idle);
    gtk_widget_set_sensitive(app->window_combo, idle);
    gtk_widget_set_sensitive(app->window_refresh_btn, idle);
    gtk_widget_set_sensitive(app->chk_sys_audio, idle);
    gtk_widget_set_sensitive(app->chk_mic_audio, idle);
    gtk_widget_set_sensitive(app->mic_combo, idle && app->mic_audio);
    gtk_widget_set_sensitive(app->chk_cursor, idle);

    if (app->source == SR_SOURCE_SCREEN) {
        gtk_widget_hide(app->window_picker_box);
    } else {
        gtk_widget_show_all(app->window_picker_box);
    }

    char k_rec[48], k_pause[48], k_sys[48], k_mic[48], k_cur[48];
    format_accel_human(app->shortcuts.toggle_record, k_rec, sizeof(k_rec));
    format_accel_human(app->shortcuts.toggle_pause, k_pause, sizeof(k_pause));
    format_accel_human(app->shortcuts.toggle_sys_audio, k_sys, sizeof(k_sys));
    format_accel_human(app->shortcuts.toggle_mic, k_mic, sizeof(k_mic));
    format_accel_human(app->shortcuts.toggle_cursor, k_cur, sizeof(k_cur));

    char rec_label[96];
    GtkStyleContext *rec_ctx = gtk_widget_get_style_context(app->btn_record);
    if (idle) {
        snprintf(rec_label, sizeof(rec_label), "●  Start Recording (%s)", k_rec);
        gtk_style_context_remove_class(rec_ctx, "sr-stop-btn");
        gtk_style_context_add_class(rec_ctx, "sr-rec-btn");
        gtk_widget_set_sensitive(app->btn_record, TRUE);
        gtk_widget_set_sensitive(app->btn_pause, FALSE);
        char idle_pause[64];
        snprintf(idle_pause, sizeof(idle_pause), "Pause (%s)", k_pause);
        gtk_button_set_label(GTK_BUTTON(app->btn_pause), idle_pause);
    } else if (busy_final) {
        snprintf(rec_label, sizeof(rec_label), "Encoding MP4...");
        gtk_widget_set_sensitive(app->btn_record, FALSE);
        gtk_widget_set_sensitive(app->btn_pause, FALSE);
    } else {
        snprintf(rec_label, sizeof(rec_label), "■  Stop & Save MP4 (%s)", k_rec);
        gtk_style_context_remove_class(rec_ctx, "sr-rec-btn");
        gtk_style_context_add_class(rec_ctx, "sr-stop-btn");
        gtk_widget_set_sensitive(app->btn_record, TRUE);
        gtk_widget_set_sensitive(app->btn_pause, TRUE);

        char pause_lbl[64];
        snprintf(
            pause_lbl,
            sizeof(pause_lbl),
            "%s (%s)",
            app->state == APP_STATE_PAUSED ? "Resume" : "Pause",
            k_pause
        );
        gtk_button_set_label(GTK_BUTTON(app->btn_pause), pause_lbl);
    }
    gtk_button_set_label(GTK_BUTTON(app->btn_record), rec_label);

    gtk_label_set_text(GTK_LABEL(app->lbl_sys_shortcut), k_sys);
    gtk_label_set_text(GTK_LABEL(app->lbl_mic_shortcut), k_mic);
    gtk_label_set_text(GTK_LABEL(app->lbl_cur_shortcut), k_cur);
}

static void on_source_radio_toggled(GtkToggleButton *btn, gpointer user_data) {
    if (!gtk_toggle_button_get_active(btn)) return;
    ScreenRecApp *app = (ScreenRecApp *)user_data;
    if (GTK_WIDGET(btn) == app->btn_src_screen) app->source = SR_SOURCE_SCREEN;
    else if (GTK_WIDGET(btn) == app->btn_src_window) app->source = SR_SOURCE_WINDOW;
    else app->source = SR_SOURCE_BROWSER;

    if (app->source != SR_SOURCE_SCREEN) {
        refresh_x11_window_list(app);
    }
    update_ui_state(app);
}

static void on_refresh_windows_clicked(GtkButton *b, gpointer user_data) {
    (void)b;
    refresh_x11_window_list((ScreenRecApp *)user_data);
}

static void on_sys_audio_toggled(GtkToggleButton *b, gpointer user_data) {
    ScreenRecApp *app = (ScreenRecApp *)user_data;
    app->system_audio = gtk_toggle_button_get_active(b);
}

static void on_mic_audio_toggled(GtkToggleButton *b, gpointer user_data) {
    ScreenRecApp *app = (ScreenRecApp *)user_data;
    app->mic_audio = gtk_toggle_button_get_active(b);
    gtk_widget_set_sensitive(app->mic_combo, app->mic_audio && app->state == APP_STATE_IDLE);
}

static void on_cursor_toggled(GtkToggleButton *b, gpointer user_data) {
    ScreenRecApp *app = (ScreenRecApp *)user_data;
    app->include_cursor = gtk_toggle_button_get_active(b);
}

static void on_record_clicked(GtkButton *b, gpointer user_data) {
    (void)b;
    start_or_stop_recording((ScreenRecApp *)user_data);
}

static void on_pause_clicked(GtkButton *b, gpointer user_data) {
    (void)b;
    pause_or_resume_recording((ScreenRecApp *)user_data);
}

static void on_open_saved_folder_clicked(GtkButton *b, gpointer user_data) {
    (void)b;
    ScreenRecApp *app = (ScreenRecApp *)user_data;
    if (!app->last_saved_mp4_path[0]) return;
    char dir[512];
    snprintf(dir, sizeof(dir), "%s", app->last_saved_mp4_path);
    char *slash = strrchr(dir, '/');
    if (slash) *slash = '\0';
    char uri[600];
    snprintf(uri, sizeof(uri), "file://%s", dir);
    gtk_show_uri_on_window(GTK_WINDOW(app->window), uri, GDK_CURRENT_TIME, NULL);
}

static bool accel_matches_event(const char *accel, GdkEventKey *ev) {
    guint keyval = 0;
    GdkModifierType mods = 0;
    gtk_accelerator_parse(accel, &keyval, &mods);
    if (keyval == 0) return false;
    GdkModifierType clean = ev->state & gtk_accelerator_get_default_mod_mask();
    return (gdk_keyval_to_lower(ev->keyval) == gdk_keyval_to_lower(keyval)) && (clean == mods);
}

static gboolean on_window_key_press(GtkWidget *widget, GdkEventKey *ev, gpointer user_data) {
    (void)widget;
    ScreenRecApp *app = (ScreenRecApp *)user_data;

    if (accel_matches_event(app->shortcuts.toggle_record, ev)) {
        start_or_stop_recording(app);
        return TRUE;
    }
    if (accel_matches_event(app->shortcuts.toggle_pause, ev)) {
        pause_or_resume_recording(app);
        return TRUE;
    }
    if (app->state == APP_STATE_IDLE) {
        if (accel_matches_event(app->shortcuts.toggle_sys_audio, ev)) {
            gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_sys_audio), !app->system_audio);
            return TRUE;
        }
        if (accel_matches_event(app->shortcuts.toggle_mic, ev)) {
            gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_mic_audio), !app->mic_audio);
            return TRUE;
        }
        if (accel_matches_event(app->shortcuts.toggle_cursor, ev)) {
            gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_cursor), !app->include_cursor);
            return TRUE;
        }
    }
    return FALSE;
}

static void on_shortcuts_dialog_clicked(GtkButton *b, gpointer user_data) {
    (void)b;
    ScreenRecApp *app = (ScreenRecApp *)user_data;

    GtkWidget *dlg = gtk_dialog_new_with_buttons(
        "Keyboard Shortcuts",
        GTK_WINDOW(app->window),
        GTK_DIALOG_MODAL | GTK_DIALOG_DESTROY_WITH_PARENT,
        "Reset Defaults",
        100,
        "_Cancel",
        GTK_RESPONSE_CANCEL,
        "_Save Shortcuts",
        GTK_RESPONSE_ACCEPT,
        NULL
    );
    gtk_window_set_default_size(GTK_WINDOW(dlg), 420, 260);

    GtkWidget *content = gtk_dialog_get_content_area(GTK_DIALOG(dlg));
    GtkWidget *grid = gtk_grid_new();
    gtk_grid_set_row_spacing(GTK_GRID(grid), 10);
    gtk_grid_set_column_spacing(GTK_GRID(grid), 14);
    gtk_widget_set_margin_start(grid, 16);
    gtk_widget_set_margin_end(grid, 16);
    gtk_widget_set_margin_top(grid, 14);
    gtk_widget_set_margin_bottom(grid, 14);

    const char *labels[5] = {
        "Start / Stop Recording:",
        "Pause / Resume:",
        "Toggle System Audio:",
        "Toggle Microphone:",
        "Toggle Mouse Cursor:",
    };
    const char *vals[5] = {
        app->shortcuts.toggle_record,
        app->shortcuts.toggle_pause,
        app->shortcuts.toggle_sys_audio,
        app->shortcuts.toggle_mic,
        app->shortcuts.toggle_cursor,
    };

    GtkWidget *entries[5];
    for (int i = 0; i < 5; i++) {
        GtkWidget *lbl = gtk_label_new(labels[i]);
        gtk_widget_set_halign(lbl, GTK_ALIGN_START);
        entries[i] = gtk_entry_new();
        gtk_entry_set_text(GTK_ENTRY(entries[i]), vals[i]);
        gtk_grid_attach(GTK_GRID(grid), lbl, 0, i, 1, 1);
        gtk_grid_attach(GTK_GRID(grid), entries[i], 1, i, 1, 1);
    }
    gtk_container_add(GTK_CONTAINER(content), grid);
    gtk_widget_show_all(dlg);

    gint resp = gtk_dialog_run(GTK_DIALOG(dlg));
    if (resp == 100) {
        sr_shortcuts_init_defaults(&app->shortcuts);
        ensure_parent_dir(app->shortcuts_path);
        sr_shortcuts_save(app->shortcuts_path, &app->shortcuts);
#ifdef GDK_WINDOWING_X11
        register_x11_global_hotkeys(app);
#endif
        update_ui_state(app);
    } else if (resp == GTK_RESPONSE_ACCEPT) {
        SrShortcutConfig next;
        snprintf(next.toggle_record, sizeof(next.toggle_record), "%s", gtk_entry_get_text(GTK_ENTRY(entries[0])));
        snprintf(next.toggle_pause, sizeof(next.toggle_pause), "%s", gtk_entry_get_text(GTK_ENTRY(entries[1])));
        snprintf(next.toggle_sys_audio, sizeof(next.toggle_sys_audio), "%s", gtk_entry_get_text(GTK_ENTRY(entries[2])));
        snprintf(next.toggle_mic, sizeof(next.toggle_mic), "%s", gtk_entry_get_text(GTK_ENTRY(entries[3])));
        snprintf(next.toggle_cursor, sizeof(next.toggle_cursor), "%s", gtk_entry_get_text(GTK_ENTRY(entries[4])));

        if (sr_shortcuts_validate_no_duplicates(&next)) {
            app->shortcuts = next;
            ensure_parent_dir(app->shortcuts_path);
            sr_shortcuts_save(app->shortcuts_path, &app->shortcuts);
#ifdef GDK_WINDOWING_X11
            register_x11_global_hotkeys(app);
#endif
            update_ui_state(app);
        } else {
            gtk_label_set_text(
                GTK_LABEL(app->status_label),
                "Shortcut update rejected: duplicate or empty accelerator keys."
            );
        }
    }
    gtk_widget_destroy(dlg);
}

static void build_gtk_ui(ScreenRecApp *app) {
    GtkCssProvider *css = gtk_css_provider_new();
    gtk_css_provider_load_from_data(css, APP_CSS, -1, NULL);
    gtk_style_context_add_provider_for_screen(
        gdk_screen_get_default(),
        GTK_STYLE_PROVIDER(css),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION
    );
    g_object_unref(css);

    app->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(app->window), "ScreenRec");
    gtk_window_set_default_size(GTK_WINDOW(app->window), 560, 520);
    gtk_window_set_position(GTK_WINDOW(app->window), GTK_WIN_POS_CENTER);
    gtk_window_set_icon_name(GTK_WINDOW(app->window), "screenrec");

    app->header_bar = gtk_header_bar_new();
    gtk_header_bar_set_show_close_button(GTK_HEADER_BAR(app->header_bar), TRUE);
    gtk_header_bar_set_decoration_layout(GTK_HEADER_BAR(app->header_bar), ":minimize,close");
    gtk_header_bar_set_title(GTK_HEADER_BAR(app->header_bar), "ScreenRec");

    char subtitle[224];
    snprintf(
        subtitle,
        sizeof(subtitle),
        "%s · %s",
        app->display_info.label,
        app->display_info.distro_name[0] ? app->display_info.distro_name : "MP4 (H.264 / AAC)"
    );
    gtk_header_bar_set_subtitle(GTK_HEADER_BAR(app->header_bar), subtitle);

    app->timer_label = gtk_label_new("00:00");
    gtk_style_context_add_class(gtk_widget_get_style_context(app->timer_label), "sr-mono");
    gtk_header_bar_pack_start(GTK_HEADER_BAR(app->header_bar), app->timer_label);

    GtkWidget *btn_shortcuts = gtk_button_new_with_label("Shortcuts");
    g_signal_connect(btn_shortcuts, "clicked", G_CALLBACK(on_shortcuts_dialog_clicked), app);
    gtk_header_bar_pack_end(GTK_HEADER_BAR(app->header_bar), btn_shortcuts);

    gtk_window_set_titlebar(GTK_WINDOW(app->window), app->header_bar);

    GtkWidget *root_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
    gtk_widget_set_margin_start(root_box, 16);
    gtk_widget_set_margin_end(root_box, 16);
    gtk_widget_set_margin_top(root_box, 14);
    gtk_widget_set_margin_bottom(root_box, 14);
    gtk_container_add(GTK_CONTAINER(app->window), root_box);

    /* Startup Display Server Auto-Detection Banner */
    GtkWidget *banner = gtk_box_new(GTK_ORIENTATION_VERTICAL, 3);
    gtk_style_context_add_class(gtk_widget_get_style_context(banner), "sr-banner");

    char badge_text[220];
    snprintf(
        badge_text,
        sizeof(badge_text),
        "Auto-Detected Display Server: %s",
        app->display_info.label
    );
    app->display_badge_label = gtk_label_new(badge_text);
    gtk_widget_set_halign(app->display_badge_label, GTK_ALIGN_START);
    gtk_style_context_add_class(gtk_widget_get_style_context(app->display_badge_label), "sr-section");

    char detail_text[320];
    snprintf(
        detail_text,
        sizeof(detail_text),
        "Backend: %s · %s",
        app->display_info.backend,
        app->display_info.detected_via
    );
    app->display_detail_label = gtk_label_new(detail_text);
    gtk_widget_set_halign(app->display_detail_label, GTK_ALIGN_START);
    gtk_label_set_ellipsize(GTK_LABEL(app->display_detail_label), PANGO_ELLIPSIZE_END);
    gtk_style_context_add_class(gtk_widget_get_style_context(app->display_detail_label), "sr-muted");

    gtk_box_pack_start(GTK_BOX(banner), app->display_badge_label, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(banner), app->display_detail_label, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(root_box), banner, FALSE, FALSE, 0);

    /* Card 1: Capture Source */
    GtkWidget *src_card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 10);
    gtk_style_context_add_class(gtk_widget_get_style_context(src_card), "sr-card");

    GtkWidget *src_hdr = gtk_label_new("1. Capture Target");
    gtk_widget_set_halign(src_hdr, GTK_ALIGN_START);
    gtk_style_context_add_class(gtk_widget_get_style_context(src_hdr), "sr-section");
    gtk_box_pack_start(GTK_BOX(src_card), src_hdr, FALSE, FALSE, 0);

    GtkWidget *radio_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_box_set_homogeneous(GTK_BOX(radio_row), TRUE);
    app->btn_src_screen  = gtk_radio_button_new_with_label(NULL, "Entire Screen");
    app->btn_src_window  = gtk_radio_button_new_with_label_from_widget(
        GTK_RADIO_BUTTON(app->btn_src_screen),
        "App Window"
    );
    app->btn_src_browser = gtk_radio_button_new_with_label_from_widget(
        GTK_RADIO_BUTTON(app->btn_src_screen),
        "Browser Tab / Window"
    );

    GtkWidget *seg_btns[3] = { app->btn_src_screen, app->btn_src_window, app->btn_src_browser };
    for (int i = 0; i < 3; i++) {
        gtk_toggle_button_set_mode(GTK_TOGGLE_BUTTON(seg_btns[i]), FALSE);
        gtk_style_context_add_class(gtk_widget_get_style_context(seg_btns[i]), "sr-seg-btn");
        g_signal_connect(seg_btns[i], "toggled", G_CALLBACK(on_source_radio_toggled), app);
        gtk_box_pack_start(GTK_BOX(radio_row), seg_btns[i], TRUE, TRUE, 0);
    }
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->btn_src_screen), TRUE);
    gtk_box_pack_start(GTK_BOX(src_card), radio_row, FALSE, FALSE, 0);

    app->window_picker_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_no_show_all(app->window_picker_box, TRUE);
    app->window_combo      = gtk_combo_box_text_new();
    gtk_widget_set_hexpand(app->window_combo, TRUE);
    app->window_refresh_btn = gtk_button_new_with_label("Refresh");
    g_signal_connect(app->window_refresh_btn, "clicked", G_CALLBACK(on_refresh_windows_clicked), app);
    gtk_widget_show(app->window_combo);
    gtk_widget_show(app->window_refresh_btn);
    gtk_box_pack_start(GTK_BOX(app->window_picker_box), app->window_combo, TRUE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(app->window_picker_box), app->window_refresh_btn, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(src_card), app->window_picker_box, FALSE, FALSE, 0);

    gtk_box_pack_start(GTK_BOX(root_box), src_card, FALSE, FALSE, 0);

    /* Card 2: Audio & Mouse Cursor Options */
    GtkWidget *opt_card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 10);
    gtk_style_context_add_class(gtk_widget_get_style_context(opt_card), "sr-card");

    GtkWidget *opt_hdr = gtk_label_new("2. Audio & Mouse Pointer Options");
    gtk_widget_set_halign(opt_hdr, GTK_ALIGN_START);
    gtk_style_context_add_class(gtk_widget_get_style_context(opt_hdr), "sr-section");
    gtk_box_pack_start(GTK_BOX(opt_card), opt_hdr, FALSE, FALSE, 0);

    /* System Audio Row */
    GtkWidget *row_sys = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    app->chk_sys_audio = gtk_check_button_new_with_label("Record System Audio (Desktop Output)");
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_sys_audio), app->system_audio);
    g_signal_connect(app->chk_sys_audio, "toggled", G_CALLBACK(on_sys_audio_toggled), app);
    app->lbl_sys_shortcut = gtk_label_new(app->shortcuts.toggle_sys_audio);
    gtk_style_context_add_class(gtk_widget_get_style_context(app->lbl_sys_shortcut), "sr-kbd");
    gtk_box_pack_start(GTK_BOX(row_sys), app->chk_sys_audio, TRUE, TRUE, 0);
    gtk_box_pack_end(GTK_BOX(row_sys), app->lbl_sys_shortcut, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(opt_card), row_sys, FALSE, FALSE, 0);

    /* Microphone Row + Device Selector */
    GtkWidget *row_mic = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    app->chk_mic_audio = gtk_check_button_new_with_label("Record Microphone Voiceover");
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_mic_audio), app->mic_audio);
    g_signal_connect(app->chk_mic_audio, "toggled", G_CALLBACK(on_mic_audio_toggled), app);
    app->lbl_mic_shortcut = gtk_label_new(app->shortcuts.toggle_mic);
    gtk_style_context_add_class(gtk_widget_get_style_context(app->lbl_mic_shortcut), "sr-kbd");
    gtk_box_pack_start(GTK_BOX(row_mic), app->chk_mic_audio, TRUE, TRUE, 0);
    gtk_box_pack_end(GTK_BOX(row_mic), app->lbl_mic_shortcut, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(opt_card), row_mic, FALSE, FALSE, 0);

    app->mic_combo = gtk_combo_box_text_new();
    for (int i = 0; i < app->audio_info.mic_count; i++) {
        gtk_combo_box_text_append_text(GTK_COMBO_BOX_TEXT(app->mic_combo), app->audio_info.mic_labels[i]);
    }
    gtk_combo_box_set_active(GTK_COMBO_BOX(app->mic_combo), 0);
    gtk_widget_set_sensitive(app->mic_combo, app->mic_audio);
    gtk_box_pack_start(GTK_BOX(opt_card), app->mic_combo, FALSE, FALSE, 0);

    /* Mouse Cursor Row */
    GtkWidget *row_cur = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    app->chk_cursor = gtk_check_button_new_with_label("Include Mouse Cursor in Screencast");
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_cursor), app->include_cursor);
    g_signal_connect(app->chk_cursor, "toggled", G_CALLBACK(on_cursor_toggled), app);
    app->lbl_cur_shortcut = gtk_label_new(app->shortcuts.toggle_cursor);
    gtk_style_context_add_class(gtk_widget_get_style_context(app->lbl_cur_shortcut), "sr-kbd");
    gtk_box_pack_start(GTK_BOX(row_cur), app->chk_cursor, TRUE, TRUE, 0);
    gtk_box_pack_end(GTK_BOX(row_cur), app->lbl_cur_shortcut, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(opt_card), row_cur, FALSE, FALSE, 0);

    gtk_box_pack_start(GTK_BOX(root_box), opt_card, FALSE, FALSE, 0);

    /* Card 3: Primary Recording Actions */
    GtkWidget *act_card = gtk_box_new(GTK_ORIENTATION_VERTICAL, 10);
    gtk_style_context_add_class(gtk_widget_get_style_context(act_card), "sr-card");

    GtkWidget *btn_row = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 10);
    app->btn_record = gtk_button_new_with_label("●  Start Recording (F9)");
    gtk_widget_set_hexpand(app->btn_record, TRUE);
    g_signal_connect(app->btn_record, "clicked", G_CALLBACK(on_record_clicked), app);

    app->btn_pause = gtk_button_new_with_label("Pause (F10)");
    g_signal_connect(app->btn_pause, "clicked", G_CALLBACK(on_pause_clicked), app);

    gtk_box_pack_start(GTK_BOX(btn_row), app->btn_record, TRUE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(btn_row), app->btn_pause, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(act_card), btn_row, FALSE, FALSE, 0);

    app->status_label = gtk_label_new("Ready — exports standard H.264 + AAC .mp4 video.");
    gtk_widget_set_halign(app->status_label, GTK_ALIGN_START);
    gtk_label_set_line_wrap(GTK_LABEL(app->status_label), TRUE);
    gtk_style_context_add_class(gtk_widget_get_style_context(app->status_label), "sr-muted");
    gtk_box_pack_start(GTK_BOX(act_card), app->status_label, FALSE, FALSE, 0);

    app->saved_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
    gtk_widget_set_no_show_all(app->saved_box, TRUE);
    app->saved_path_label = gtk_label_new("");
    gtk_label_set_ellipsize(GTK_LABEL(app->saved_path_label), PANGO_ELLIPSIZE_MIDDLE);
    gtk_widget_set_halign(app->saved_path_label, GTK_ALIGN_START);
    GtkWidget *btn_open_folder = gtk_button_new_with_label("Open Folder");
    g_signal_connect(btn_open_folder, "clicked", G_CALLBACK(on_open_saved_folder_clicked), app);
    gtk_widget_show(app->saved_path_label);
    gtk_widget_show(btn_open_folder);
    gtk_box_pack_start(GTK_BOX(app->saved_box), app->saved_path_label, TRUE, TRUE, 0);
    gtk_box_pack_end(GTK_BOX(app->saved_box), btn_open_folder, FALSE, FALSE, 0);
    gtk_box_pack_start(GTK_BOX(act_card), app->saved_box, FALSE, FALSE, 0);

    gtk_box_pack_start(GTK_BOX(root_box), act_card, FALSE, FALSE, 0);

    g_signal_connect(app->window, "key-press-event", G_CALLBACK(on_window_key_press), app);
    g_signal_connect(app->window, "destroy", G_CALLBACK(on_main_window_destroy), NULL);
}

/* Automated headless GUI & X11grab MP4 verification mode (--gui-self-test <out.png>) */
static int run_gui_self_test(ScreenRecApp *app, const char *screenshot_path) {
    gtk_widget_show_all(app->window);
    update_ui_state(app);

    /* Pump GTK event loop so Xvfb / compositor maps and paints the GTK3 window */
    for (int i = 0; i < 40; i++) {
        while (gtk_events_pending()) gtk_main_iteration_do(FALSE);
        g_usleep(10000);
    }

    /* Exercise source & toggle controls programmatically */
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->btn_src_window), TRUE);
    while (gtk_events_pending()) gtk_main_iteration_do(FALSE);
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->btn_src_screen), TRUE);
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_mic_audio), TRUE);
    gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(app->chk_mic_audio), FALSE);
    while (gtk_events_pending()) gtk_main_iteration_do(FALSE);

    /* Capture rendered GTK3 GdkWindow to PNG */
    if (screenshot_path && screenshot_path[0]) {
        GdkWindow *gdk_win = gtk_widget_get_window(app->window);
        if (gdk_win) {
            int w = gdk_window_get_width(gdk_win);
            int h = gdk_window_get_height(gdk_win);
            GdkPixbuf *pix = gdk_pixbuf_get_from_window(gdk_win, 0, 0, w, h);
            if (pix) {
                ensure_parent_dir(screenshot_path);
                gdk_pixbuf_save(pix, screenshot_path, "png", NULL, NULL);
                g_object_unref(pix);
            }
        }
    }

    /* If running on X11 (e.g. Xvfb), also record a live 1-second X11 screen MP4 to verify end-to-end! */
    if (app->display_info.protocol == SR_PROTO_X11) {
        char test_mp4[256];
        snprintf(test_mp4, sizeof(test_mp4), "%s/screenrec-gtk-selftest-%u.mp4", g_get_tmp_dir(), (unsigned)getpid());
        unlink(test_mp4);

        SrCaptureConfig cfg = {
            .source          = SR_SOURCE_SCREEN,
            .system_audio    = false,
            .mic_audio       = false,
            .include_cursor  = true,
            .x11_display     = app->display_info.x11_display[0] ? app->display_info.x11_display : ":0",
            .capture_x       = 0,
            .capture_y       = 0,
            .capture_width   = 640,
            .capture_height  = 480,
            .output_mp4_path = test_mp4,
        };

        char **ff_argv = sr_build_x11_ffmpeg_argv(&cfg);
        GPid pid = 0;
        gint in_fd = -1;
        if (!g_spawn_async_with_pipes(
                NULL,
                ff_argv,
                NULL,
                G_SPAWN_SEARCH_PATH | G_SPAWN_DO_NOT_REAP_CHILD,
                NULL,
                NULL,
                &pid,
                &in_fd,
                NULL,
                NULL,
                NULL
            )) {
            sr_free_argv(ff_argv);
            fprintf(stderr, "[SelfTest] Failed to spawn ffmpeg x11grab\n");
            return 1;
        }
        sr_free_argv(ff_argv);

        g_usleep(900000); /* record ~0.9s of the live GTK3 window on Xvfb */
        ssize_t _w = write(in_fd, "q\n", 2);
        (void)_w;
        close(in_fd);

        int wstatus = 0;
        waitpid(pid, &wstatus, 0);
        g_spawn_close_pid(pid);

        FILE *mp4_fp = fopen(test_mp4, "rb");
        if (!mp4_fp) {
            fprintf(stderr, "[SelfTest] Expected MP4 output missing at %s\n", test_mp4);
            return 1;
        }
        unsigned char hdr[12] = {0};
        size_t nread = fread(hdr, 1, sizeof(hdr), mp4_fp);
        fclose(mp4_fp);
        unlink(test_mp4);

        if (nread < 8 || memcmp(hdr + 4, "ftyp", 4) != 0) {
            fprintf(stderr, "[SelfTest] Invalid MP4 ftyp header\n");
            return 1;
        }
    }

    gtk_widget_destroy(app->window);
    return 0;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);

    bool cli_probe = false;
    const char *self_test_png = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "-v") == 0) {
            printf("ScreenRec %s (Native GTK3 C11)\n", SCREENREC_VERSION);
            return 0;
        }
        if (strcmp(argv[i], "--probe-json") == 0) {
            cli_probe = true;
        }
        if (strcmp(argv[i], "--gui-self-test") == 0 && i + 1 < argc) {
            self_test_png = argv[++i];
        }
    }

    ScreenRecApp app;
    memset(&app, 0, sizeof(app));
    app.ffmpeg_stdin_fd = -1;
    app.source          = SR_SOURCE_SCREEN;
    app.system_audio    = true;
    app.mic_audio       = false;
    app.include_cursor  = true;

    sr_bootstrap_gui_environment(!cli_probe && !self_test_png, &app.display_info);

    if (cli_probe) {
        printf(
            "{\"version\":\"%s\",\"nativeGtk\":true,\"distro\":\"%s\",\"protocol\":\"%s\",\"hasXWayland\":%s,"
            "\"label\":\"%s\",\"backend\":\"%s\",\"detectedVia\":\"%s\","
            "\"waylandDisplay\":\"%s\",\"x11Display\":\"%s\"}\n",
            SCREENREC_VERSION,
            app.display_info.distro_name,
            app.display_info.protocol == SR_PROTO_WAYLAND
                ? "wayland"
                : (app.display_info.protocol == SR_PROTO_X11 ? "x11" : "headless"),
            app.display_info.has_xwayland ? "true" : "false",
            app.display_info.label,
            app.display_info.backend,
            app.display_info.detected_via,
            app.display_info.wayland_display,
            app.display_info.x11_display
        );
        return 0;
    }

    if (!gtk_init_check(&argc, &argv)) {
        fprintf(
            stderr,
            "[ScreenRec] Could not initialize GTK3 graphical display (protocol=%s, WAYLAND_DISPLAY=%s, DISPLAY=%s).\n",
            app.display_info.label,
            getenv("WAYLAND_DISPLAY") ? getenv("WAYLAND_DISPLAY") : "",
            getenv("DISPLAY") ? getenv("DISPLAY") : ""
        );
        return 1;
    }

    refine_display_with_gdk(&app.display_info);
    sr_probe_audio_devices(&app.audio_info);

    const char *cfg_root = g_get_user_config_dir();
    snprintf(
        app.shortcuts_path,
        sizeof(app.shortcuts_path),
        "%s/screenrec/shortcuts.conf",
        cfg_root ? cfg_root : "/tmp"
    );
    sr_shortcuts_load(app.shortcuts_path, &app.shortcuts);

    build_gtk_ui(&app);

    if (self_test_png) {
        return run_gui_self_test(&app, self_test_png);
    }

    gtk_widget_show_all(app.window);
    gtk_widget_hide(app.saved_box);
    update_ui_state(&app);

#ifdef GDK_WINDOWING_X11
    GdkDisplay *gdpy = gdk_display_get_default();
    if (gdpy && GDK_IS_X11_DISPLAY(gdpy)) {
        register_x11_global_hotkeys(&app);
        gdk_window_add_filter(gdk_get_default_root_window(), x11_root_event_filter, &app);
    }
#endif

    gtk_main();

    if (app.ffmpeg_pid > 0) kill(app.ffmpeg_pid, SIGTERM);
    if (app.gst_pid > 0) kill(app.gst_pid, SIGTERM);
    return 0;
}
