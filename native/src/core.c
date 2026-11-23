#define _GNU_SOURCE
#include "core.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifdef HAVE_X11
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#endif

static void copy_str(char *dst, size_t dst_sz, const char *src) {
    if (!dst || dst_sz == 0) return;
    if (!src) {
        dst[0] = '\0';
        return;
    }
    size_t n = strlen(src);
    if (n >= dst_sz) n = dst_sz - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

static void read_os_release_pretty_name(char *out_buf, size_t out_sz) {
    copy_str(out_buf, out_sz, "Debian-based Linux");
    FILE *fp = fopen("/etc/os-release", "r");
    if (!fp) return;
    char line[256];
    while (fgets(line, sizeof(line), fp)) {
        if (strncmp(line, "PRETTY_NAME=", 12) == 0) {
            char *val = line + 12;
            size_t len = strlen(val);
            while (len > 0 && (val[len - 1] == '\n' || val[len - 1] == '\r' || val[len - 1] == '"')) {
                val[--len] = '\0';
            }
            if (val[0] == '"') val++;
            if (val[0]) copy_str(out_buf, out_sz, val);
            break;
        }
    }
    fclose(fp);
}

static void trim_inplace(char *s) {
    if (!s) return;
    size_t len = strlen(s);
    while (len > 0 && isspace((unsigned char)s[len - 1])) {
        s[--len] = '\0';
    }
    size_t start = 0;
    while (s[start] && isspace((unsigned char)s[start])) {
        start++;
    }
    if (start > 0) {
        memmove(s, s + start, len - start + 1);
    }
}

static bool run_cmd_first_line(const char *cmd, char *out_buf, size_t out_sz) {
    if (!out_buf || out_sz == 0) return false;
    out_buf[0] = '\0';
    FILE *fp = popen(cmd, "r");
    if (!fp) return false;
    bool ok = (fgets(out_buf, (int)out_sz, fp) != NULL);
    int rc = pclose(fp);
    if (!ok || rc != 0) {
        out_buf[0] = '\0';
        return false;
    }
    trim_inplace(out_buf);
    return out_buf[0] != '\0';
}

void sr_detect_display_from_inputs(
    const char    *xdg_session_type,
    const char    *wayland_display,
    const char    *x11_display,
    const char    *xdg_current_desktop,
    const char    *first_wayland_socket,
    const char    *first_x11_socket,
    const char    *logind_type,
    SrDisplayInfo *out_info
) {
    if (!out_info) return;
    memset(out_info, 0, sizeof(*out_info));

    const char *de = (xdg_current_desktop && xdg_current_desktop[0])
                         ? xdg_current_desktop
                         : "Linux Desktop";
    copy_str(out_info->desktop_env, sizeof(out_info->desktop_env), de);

    bool sess_wayland = xdg_session_type && strcasecmp(xdg_session_type, "wayland") == 0;
    bool sess_x11     = xdg_session_type && strcasecmp(xdg_session_type, "x11") == 0;
    bool log_wayland  = logind_type && strcasecmp(logind_type, "wayland") == 0;
    bool log_x11      = logind_type && strcasecmp(logind_type, "x11") == 0;

    bool has_wl_disp  = wayland_display && wayland_display[0] != '\0';
    bool has_wl_sock  = first_wayland_socket && first_wayland_socket[0] != '\0';
    bool has_x11_disp = x11_display && x11_display[0] != '\0';
    bool has_x11_sock = first_x11_socket && first_x11_socket[0] != '\0';

    bool has_wayland = sess_wayland || has_wl_disp || has_wl_sock || log_wayland;
    bool has_x11     = has_x11_disp || has_x11_sock || sess_x11 || log_x11;

    if (has_wayland) {
        out_info->protocol     = SR_PROTO_WAYLAND;
        out_info->has_xwayland = (has_x11_disp || has_x11_sock);
        copy_str(
            out_info->label,
            sizeof(out_info->label),
            out_info->has_xwayland ? "Wayland (with XWayland)" : "Wayland"
        );
        copy_str(
            out_info->backend,
            sizeof(out_info->backend),
            "xdg-desktop-portal + PipeWire ScreenCast"
        );

        if (has_wl_disp) {
            copy_str(out_info->wayland_display, sizeof(out_info->wayland_display), wayland_display);
        } else if (has_wl_sock) {
            const char *slash = strrchr(first_wayland_socket, '/');
            copy_str(
                out_info->wayland_display,
                sizeof(out_info->wayland_display),
                slash ? slash + 1 : first_wayland_socket
            );
        } else {
            copy_str(out_info->wayland_display, sizeof(out_info->wayland_display), "wayland-0");
        }

        if (has_x11_disp) {
            copy_str(out_info->x11_display, sizeof(out_info->x11_display), x11_display);
        } else if (has_x11_sock) {
            const char *xbase = strrchr(first_x11_socket, '/');
            xbase = xbase ? xbase + 1 : first_x11_socket;
            if (xbase[0] == 'X' && isdigit((unsigned char)xbase[1])) {
                snprintf(out_info->x11_display, sizeof(out_info->x11_display), ":%s", xbase + 1);
            }
        }

        if (has_wl_sock && !has_wl_disp && !sess_wayland) {
            snprintf(
                out_info->detected_via,
                sizeof(out_info->detected_via),
                "Wayland socket (%s)",
                first_wayland_socket
            );
        } else if (sess_wayland) {
            copy_str(out_info->detected_via, sizeof(out_info->detected_via), "XDG_SESSION_TYPE=wayland");
        } else if (has_wl_disp) {
            snprintf(
                out_info->detected_via,
                sizeof(out_info->detected_via),
                "WAYLAND_DISPLAY=%s",
                wayland_display
            );
        } else {
            copy_str(
                out_info->detected_via,
                sizeof(out_info->detected_via),
                "systemd-logind graphical session (wayland)"
            );
        }
        return;
    }

    if (has_x11) {
        out_info->protocol     = SR_PROTO_X11;
        out_info->has_xwayland = false;
        copy_str(out_info->label, sizeof(out_info->label), "X11 (X.Org Server)");
        copy_str(out_info->backend, sizeof(out_info->backend), "X11 Composite / FFmpeg x11grab");

        if (has_x11_disp) {
            copy_str(out_info->x11_display, sizeof(out_info->x11_display), x11_display);
        } else if (has_x11_sock) {
            const char *xbase = strrchr(first_x11_socket, '/');
            xbase = xbase ? xbase + 1 : first_x11_socket;
            if (xbase[0] == 'X' && isdigit((unsigned char)xbase[1])) {
                snprintf(out_info->x11_display, sizeof(out_info->x11_display), ":%s", xbase + 1);
            } else {
                copy_str(out_info->x11_display, sizeof(out_info->x11_display), ":0");
            }
        } else {
            copy_str(out_info->x11_display, sizeof(out_info->x11_display), ":0");
        }

        if (has_x11_sock && !has_x11_disp && !sess_x11) {
            snprintf(
                out_info->detected_via,
                sizeof(out_info->detected_via),
                "X11 socket (%s)",
                first_x11_socket
            );
        } else if (sess_x11) {
            copy_str(out_info->detected_via, sizeof(out_info->detected_via), "XDG_SESSION_TYPE=x11");
        } else if (has_x11_disp) {
            snprintf(out_info->detected_via, sizeof(out_info->detected_via), "DISPLAY=%s", x11_display);
        } else {
            copy_str(
                out_info->detected_via,
                sizeof(out_info->detected_via),
                "systemd-logind graphical session (x11)"
            );
        }
        return;
    }

    out_info->protocol = SR_PROTO_HEADLESS;
    copy_str(out_info->label, sizeof(out_info->label), "No Local X11/Wayland Compositor");
    copy_str(out_info->backend, sizeof(out_info->backend), "Headless / Unattached Session");
    copy_str(
        out_info->detected_via,
        sizeof(out_info->detected_via),
        "Compositor socket scan (none active)"
    );
}

static bool scan_first_socket(const char *dir_path, const char *prefix, char *out_path, size_t out_sz) {
    out_path[0] = '\0';
    DIR *dir = opendir(dir_path);
    if (!dir) return false;

    size_t plen = strlen(prefix);
    char best[256] = {0};
    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL) {
        if (strncmp(ent->d_name, prefix, plen) != 0) continue;
        size_t nlen = strlen(ent->d_name);
        if (nlen > 5 && strcmp(ent->d_name + nlen - 5, ".lock") == 0) continue;
        if (strcmp(prefix, "X") == 0 && !isdigit((unsigned char)ent->d_name[1])) continue;
        if (best[0] == '\0' || strcmp(ent->d_name, best) < 0) {
            copy_str(best, sizeof(best), ent->d_name);
        }
    }
    closedir(dir);

    if (best[0] == '\0') return false;
    snprintf(out_path, out_sz, "%s/%s", dir_path, best);
    return true;
}

static void maybe_drop_root_from_gui_installer(void) {
    if (geteuid() != 0) return;

    const char *uid_str = getenv("PKEXEC_UID");
    if (!uid_str || !uid_str[0]) uid_str = getenv("SUDO_UID");

    uid_t target_uid = 0;
    if (uid_str && uid_str[0]) {
        long parsed = strtol(uid_str, NULL, 10);
        if (parsed >= 1000) target_uid = (uid_t)parsed;
    }

    /* Fallback: inspect /run/user/<uid> for an active desktop session >= 1000 */
    if (target_uid == 0) {
        DIR *rdir = opendir("/run/user");
        if (rdir) {
            struct dirent *ent;
            while ((ent = readdir(rdir)) != NULL) {
                if (!isdigit((unsigned char)ent->d_name[0])) continue;
                long cand = strtol(ent->d_name, NULL, 10);
                if (cand >= 1000) {
                    char bus_path[128];
                    snprintf(bus_path, sizeof(bus_path), "/run/user/%ld/bus", cand);
                    struct stat st;
                    if (stat(bus_path, &st) == 0) {
                        target_uid = (uid_t)cand;
                        break;
                    }
                }
            }
            closedir(rdir);
        }
    }

    if (target_uid >= 1000) {
        struct passwd *pw = getpwuid(target_uid);
        if (pw) {
            char rt_dir[128];
            snprintf(rt_dir, sizeof(rt_dir), "/run/user/%u", (unsigned)target_uid);
            setenv("HOME", pw->pw_dir, 1);
            setenv("USER", pw->pw_name, 1);
            setenv("LOGNAME", pw->pw_name, 1);
            setenv("XDG_RUNTIME_DIR", rt_dir, 1);
            (void)initgroups(pw->pw_name, pw->pw_gid);
            if (setgid(pw->pw_gid) == 0 && setuid(target_uid) == 0) {
                /* Successfully switched from root GUI installer to desktop user */
            }
        }
    }
}

void sr_bootstrap_gui_environment(bool allow_privilege_drop, SrDisplayInfo *out_info) {
    if (allow_privilege_drop) {
        maybe_drop_root_from_gui_installer();
    }

    uid_t uid = getuid();
    if (!getenv("HOME") || !getenv("HOME")[0]) {
        struct passwd *pw = getpwuid(uid);
        if (pw && pw->pw_dir) {
            setenv("HOME", pw->pw_dir, 1);
        }
    }

    char runtime_dir[256] = {0};
    const char *env_rt = getenv("XDG_RUNTIME_DIR");
    if (env_rt && env_rt[0]) {
        copy_str(runtime_dir, sizeof(runtime_dir), env_rt);
    } else {
        snprintf(runtime_dir, sizeof(runtime_dir), "/run/user/%u", (unsigned)uid);
        struct stat st;
        if (stat(runtime_dir, &st) == 0 && S_ISDIR(st.st_mode)) {
            setenv("XDG_RUNTIME_DIR", runtime_dir, 1);
        } else {
            /* Non-systemd Debian derivatives (MX Linux, Devuan, antiX) fallback */
            const char *uname = getenv("USER");
            if (uname && uname[0]) {
                char alt_rt[256];
                snprintf(alt_rt, sizeof(alt_rt), "/tmp/runtime-%s", uname);
                if (stat(alt_rt, &st) == 0 && S_ISDIR(st.st_mode)) {
                    copy_str(runtime_dir, sizeof(runtime_dir), alt_rt);
                    setenv("XDG_RUNTIME_DIR", runtime_dir, 1);
                }
            }
        }
    }

    if (!getenv("DBUS_SESSION_BUS_ADDRESS") || !getenv("DBUS_SESSION_BUS_ADDRESS")[0]) {
        char bus_sock[300];
        snprintf(bus_sock, sizeof(bus_sock), "%s/bus", runtime_dir);
        struct stat st;
        if (stat(bus_sock, &st) == 0) {
            char bus_addr[340];
            snprintf(bus_addr, sizeof(bus_addr), "unix:path=%s", bus_sock);
            setenv("DBUS_SESSION_BUS_ADDRESS", bus_addr, 1);
        }
    }

    char wl_sock[256] = {0};
    char x11_sock[256] = {0};
    scan_first_socket(runtime_dir, "wayland-", wl_sock, sizeof(wl_sock));
    scan_first_socket("/tmp/.X11-unix", "X", x11_sock, sizeof(x11_sock));

    /* If launched from a GUI menu without env vars and no custom XDG_RUNTIME_DIR override,
       query systemctl --user and loginctl as additional sources */
    char logind_type[32] = {0};
    const char *xdg_sess = getenv("XDG_SESSION_TYPE");
    const char *wl_disp  = getenv("WAYLAND_DISPLAY");
    const char *x11_disp = getenv("DISPLAY");
    const char *desktop  = getenv("XDG_CURRENT_DESKTOP");
    if (!desktop || !desktop[0]) desktop = getenv("DESKTOP_SESSION");

    char sys_wl[64]   = {0};
    char sys_x11[64]  = {0};
    char sys_desk[64] = {0};

    if ((!xdg_sess || !xdg_sess[0]) && (!wl_disp || !wl_disp[0]) && (!x11_disp || !x11_disp[0]) && !wl_sock[0]) {
        FILE *fp = popen("systemctl --user show-environment 2>/dev/null", "r");
        if (fp) {
            char line[256];
            while (fgets(line, sizeof(line), fp)) {
                trim_inplace(line);
                if (strncmp(line, "XDG_SESSION_TYPE=", 17) == 0) {
                    copy_str(logind_type, sizeof(logind_type), line + 17);
                } else if (strncmp(line, "WAYLAND_DISPLAY=", 16) == 0) {
                    copy_str(sys_wl, sizeof(sys_wl), line + 16);
                } else if (strncmp(line, "DISPLAY=", 8) == 0) {
                    copy_str(sys_x11, sizeof(sys_x11), line + 8);
                } else if (strncmp(line, "XDG_CURRENT_DESKTOP=", 20) == 0) {
                    copy_str(sys_desk, sizeof(sys_desk), line + 20);
                }
            }
            pclose(fp);
        }

        if (!logind_type[0]) {
            char cmd[160];
            snprintf(
                cmd,
                sizeof(cmd),
                "loginctl list-sessions --no-legend 2>/dev/null | awk '$2 == %u {print $1; exit}'",
                (unsigned)uid
            );
            char sid[64] = {0};
            if (run_cmd_first_line(cmd, sid, sizeof(sid))) {
                snprintf(
                    cmd,
                    sizeof(cmd),
                    "loginctl show-session '%s' -p Type --value 2>/dev/null",
                    sid
                );
                run_cmd_first_line(cmd, logind_type, sizeof(logind_type));
            }
        }
    }

    SrDisplayInfo detected;
    sr_detect_display_from_inputs(
        xdg_sess,
        (wl_disp && wl_disp[0]) ? wl_disp : sys_wl,
        (x11_disp && x11_disp[0]) ? x11_disp : sys_x11,
        (desktop && desktop[0]) ? desktop : sys_desk,
        wl_sock,
        x11_sock,
        logind_type,
        &detected
    );

    /* Export discovered display sockets BEFORE gtk_init_check so GTK3 connects cleanly */
    if (detected.protocol == SR_PROTO_WAYLAND) {
        if ((!wl_disp || !wl_disp[0]) && detected.wayland_display[0]) {
            setenv("WAYLAND_DISPLAY", detected.wayland_display, 1);
        }
        if ((!x11_disp || !x11_disp[0]) && detected.x11_display[0]) {
            setenv("DISPLAY", detected.x11_display, 1);
        }
        setenv("XDG_SESSION_TYPE", "wayland", 1);
    } else if (detected.protocol == SR_PROTO_X11) {
        if ((!x11_disp || !x11_disp[0]) && detected.x11_display[0]) {
            setenv("DISPLAY", detected.x11_display, 1);
        }
        setenv("XDG_SESSION_TYPE", "x11", 1);
    }

    read_os_release_pretty_name(detected.distro_name, sizeof(detected.distro_name));

    if (out_info) {
        *out_info = detected;
    }
}

void sr_probe_audio_devices(SrAudioDevices *out_audio) {
    if (!out_audio) return;
    memset(out_audio, 0, sizeof(*out_audio));
    out_audio->pulse_available = false;
    copy_str(out_audio->default_sink_monitor, sizeof(out_audio->default_sink_monitor), "default");
    copy_str(out_audio->default_mic_source, sizeof(out_audio->default_mic_source), "default");
    copy_str(out_audio->audio_server_label, sizeof(out_audio->audio_server_label), "PulseAudio / PipeWire");

    const char *rt = getenv("XDG_RUNTIME_DIR");
    if (rt && rt[0]) {
        char pulse_sock[300];
        snprintf(pulse_sock, sizeof(pulse_sock), "%s/pulse/native", rt);
        struct stat st;
        if (stat(pulse_sock, &st) == 0) {
            out_audio->pulse_available = true;
        }
    }

    char server_name[128] = {0};
    if (run_cmd_first_line("pactl info 2>/dev/null | sed -n 's/^Server Name: //p'", server_name, sizeof(server_name))) {
        out_audio->pulse_available = true;
        if (strcasestr(server_name, "pipewire")) {
            copy_str(out_audio->audio_server_label, sizeof(out_audio->audio_server_label), "PipeWire (PulseAudio Sink Monitor)");
        } else {
            copy_str(out_audio->audio_server_label, sizeof(out_audio->audio_server_label), "PulseAudio");
        }
    }

    char sink[160] = {0};
    if (run_cmd_first_line("pactl get-default-sink 2>/dev/null", sink, sizeof(sink)) &&
        strcmp(sink, "@DEFAULT_SINK@") != 0) {
        snprintf(out_audio->default_sink_monitor, sizeof(out_audio->default_sink_monitor), "%s.monitor", sink);
    } else if (run_cmd_first_line("pactl list short sources 2>/dev/null | awk '$2 ~ /\\.monitor$/ {print $2; exit}'", sink, sizeof(sink))) {
        copy_str(out_audio->default_sink_monitor, sizeof(out_audio->default_sink_monitor), sink);
    }

    char def_mic[160] = {0};
    if (run_cmd_first_line("pactl get-default-source 2>/dev/null", def_mic, sizeof(def_mic)) &&
        strcmp(def_mic, "@DEFAULT_SOURCE@") != 0 &&
        !strstr(def_mic, ".monitor")) {
        copy_str(out_audio->default_mic_source, sizeof(out_audio->default_mic_source), def_mic);
    }

    FILE *fp = popen("pactl list short sources 2>/dev/null", "r");
    if (fp) {
        char line[512];
        while (fgets(line, sizeof(line), fp) && out_audio->mic_count < 16) {
            char idx[32] = {0};
            char name[192] = {0};
            if (sscanf(line, "%31s %191s", idx, name) == 2) {
                if (strstr(name, ".monitor") != NULL) continue;
                int i = out_audio->mic_count++;
                copy_str(out_audio->mic_sources[i], sizeof(out_audio->mic_sources[i]), name);
                copy_str(out_audio->mic_labels[i], sizeof(out_audio->mic_labels[i]), name);
                if (strcmp(out_audio->default_mic_source, "default") == 0) {
                    copy_str(out_audio->default_mic_source, sizeof(out_audio->default_mic_source), name);
                }
            }
        }
        pclose(fp);
    }

    if (out_audio->mic_count == 0) {
        out_audio->mic_count = 1;
        copy_str(out_audio->mic_sources[0], sizeof(out_audio->mic_sources[0]), "default");
        copy_str(out_audio->mic_labels[0], sizeof(out_audio->mic_labels[0]), "Default System Microphone");
    }
}

int sr_list_x11_windows(const char *display_name, SrWindowEntry *out_list, int max_entries) {
    if (!out_list || max_entries <= 0) return 0;
#ifdef HAVE_X11
    Display *dpy = XOpenDisplay(display_name && display_name[0] ? display_name : NULL);
    if (!dpy) return 0;

    Window root = DefaultRootWindow(dpy);
    Atom net_client_list = XInternAtom(dpy, "_NET_CLIENT_LIST", False);
    Atom net_wm_name     = XInternAtom(dpy, "_NET_WM_NAME", False);
    Atom utf8_string     = XInternAtom(dpy, "UTF8_STRING", False);

    Atom actual_type;
    int actual_format;
    unsigned long nitems = 0, bytes_after = 0;
    unsigned char *prop = NULL;

    int count = 0;
    if (XGetWindowProperty(
            dpy,
            root,
            net_client_list,
            0,
            1024,
            False,
            XA_WINDOW,
            &actual_type,
            &actual_format,
            &nitems,
            &bytes_after,
            &prop
        ) == Success && prop) {
        Window *wins = (Window *)prop;
        for (unsigned long i = 0; i < nitems && count < max_entries; i++) {
            Window w = wins[i];
            XWindowAttributes attr;
            if (!XGetWindowAttributes(dpy, w, &attr)) continue;
            if (attr.map_state != IsViewable || attr.width < 80 || attr.height < 60) continue;

            char title[192] = {0};
            unsigned char *name_prop = NULL;
            Atom t_type;
            int t_fmt;
            unsigned long t_items = 0, t_after = 0;
            if (XGetWindowProperty(
                    dpy,
                    w,
                    net_wm_name,
                    0,
                    128,
                    False,
                    utf8_string,
                    &t_type,
                    &t_fmt,
                    &t_items,
                    &t_after,
                    &name_prop
                ) == Success && name_prop) {
                copy_str(title, sizeof(title), (const char *)name_prop);
                XFree(name_prop);
            }
            if (!title[0]) {
                char *legacy = NULL;
                if (XFetchName(dpy, w, &legacy) && legacy) {
                    copy_str(title, sizeof(title), legacy);
                    XFree(legacy);
                }
            }
            if (!title[0] || strcmp(title, "ScreenRec") == 0) continue;

            char wm_cls[96] = {0};
            XClassHint ch = {0};
            if (XGetClassHint(dpy, w, &ch)) {
                if (ch.res_class) copy_str(wm_cls, sizeof(wm_cls), ch.res_class);
                if (ch.res_name) XFree(ch.res_name);
                if (ch.res_class) XFree(ch.res_class);
            }

            int rx = 0, ry = 0;
            Window child_ret;
            XTranslateCoordinates(dpy, w, root, 0, 0, &rx, &ry, &child_ret);
            if (rx < 0) rx = 0;
            if (ry < 0) ry = 0;

            SrWindowEntry *ent = &out_list[count++];
            memset(ent, 0, sizeof(*ent));
            ent->window_id = (unsigned long)w;
            copy_str(ent->title, sizeof(ent->title), title);
            copy_str(ent->wm_class, sizeof(ent->wm_class), wm_cls);
            ent->x = rx;
            ent->y = ry;
            ent->width  = (attr.width / 2) * 2;
            ent->height = (attr.height / 2) * 2;
            ent->is_browser = (
                strcasestr(wm_cls, "firefox") != NULL ||
                strcasestr(wm_cls, "chromium") != NULL ||
                strcasestr(wm_cls, "chrome") != NULL ||
                strcasestr(wm_cls, "brave") != NULL ||
                strcasestr(wm_cls, "edge") != NULL ||
                strcasestr(title, "Mozilla Firefox") != NULL ||
                strcasestr(title, "Chromium") != NULL ||
                strcasestr(title, "Google Chrome") != NULL
            );
        }
        XFree(prop);
    }

    XCloseDisplay(dpy);
    return count;
#else
    (void)display_name;
    return 0;
#endif
}

typedef struct {
    char **items;
    size_t count;
    size_t cap;
} ArgvBuilder;

static void argv_push(ArgvBuilder *b, const char *arg) {
    if (b->count + 2 > b->cap) {
        b->cap = b->cap ? b->cap * 2 : 32;
        b->items = realloc(b->items, b->cap * sizeof(char *));
    }
    b->items[b->count++] = strdup(arg ? arg : "");
    b->items[b->count]   = NULL;
}

static void append_audio_and_mp4_args(ArgvBuilder *b, const SrCaptureConfig *cfg) {
    const char *sink = (cfg->sink_monitor && cfg->sink_monitor[0]) ? cfg->sink_monitor : "default";
    const char *mic  = (cfg->mic_source && cfg->mic_source[0]) ? cfg->mic_source : "default";

    if (cfg->system_audio) {
        argv_push(b, "-f");
        argv_push(b, "pulse");
        argv_push(b, "-thread_queue_size");
        argv_push(b, "512");
        argv_push(b, "-i");
        argv_push(b, sink);
    }
    if (cfg->mic_audio) {
        argv_push(b, "-f");
        argv_push(b, "pulse");
        argv_push(b, "-thread_queue_size");
        argv_push(b, "512");
        argv_push(b, "-i");
        argv_push(b, mic);
    }

    argv_push(b, "-vf");
    argv_push(b, "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    argv_push(b, "-c:v");
    argv_push(b, "libx264");
    argv_push(b, "-preset");
    argv_push(b, "veryfast");
    argv_push(b, "-crf");
    argv_push(b, "23");
    argv_push(b, "-pix_fmt");
    argv_push(b, "yuv420p");

    if (cfg->system_audio && cfg->mic_audio) {
        argv_push(b, "-filter_complex");
        argv_push(b, "[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]");
        argv_push(b, "-map");
        argv_push(b, "0:v");
        argv_push(b, "-map");
        argv_push(b, "[aout]");
        argv_push(b, "-c:a");
        argv_push(b, "aac");
        argv_push(b, "-b:a");
        argv_push(b, "160k");
    } else if (cfg->system_audio || cfg->mic_audio) {
        argv_push(b, "-c:a");
        argv_push(b, "aac");
        argv_push(b, "-b:a");
        argv_push(b, "128k");
    } else {
        argv_push(b, "-an");
    }

    argv_push(b, "-movflags");
    argv_push(b, "+faststart");
    argv_push(b, cfg->output_mp4_path ? cfg->output_mp4_path : "recording.mp4");
}

char **sr_build_x11_ffmpeg_argv(const SrCaptureConfig *cfg) {
    if (!cfg) return NULL;
    ArgvBuilder b = {0};

    int w = cfg->capture_width > 0 ? (cfg->capture_width / 2) * 2 : 1280;
    int h = cfg->capture_height > 0 ? (cfg->capture_height / 2) * 2 : 720;
    int x = cfg->capture_x >= 0 ? cfg->capture_x : 0;
    int y = cfg->capture_y >= 0 ? cfg->capture_y : 0;

    char size_arg[64];
    snprintf(size_arg, sizeof(size_arg), "%dx%d", w, h);

    const char *disp = (cfg->x11_display && cfg->x11_display[0]) ? cfg->x11_display : ":0";
    char input_spec[128];
    snprintf(input_spec, sizeof(input_spec), "%s+%d,%d", disp, x, y);

    argv_push(&b, "ffmpeg");
    argv_push(&b, "-y");
    argv_push(&b, "-f");
    argv_push(&b, "x11grab");
    argv_push(&b, "-framerate");
    argv_push(&b, "30");
    argv_push(&b, "-draw_mouse");
    argv_push(&b, cfg->include_cursor ? "1" : "0");
    argv_push(&b, "-video_size");
    argv_push(&b, size_arg);
    argv_push(&b, "-thread_queue_size");
    argv_push(&b, "512");
    argv_push(&b, "-i");
    argv_push(&b, input_spec);

    append_audio_and_mp4_args(&b, cfg);
    return b.items;
}

char **sr_build_wayland_ffmpeg_argv(const SrCaptureConfig *cfg) {
    if (!cfg) return NULL;
    ArgvBuilder b = {0};

    argv_push(&b, "ffmpeg");
    argv_push(&b, "-y");
    argv_push(&b, "-thread_queue_size");
    argv_push(&b, "512");
    argv_push(&b, "-f");
    argv_push(&b, "matroska");
    argv_push(&b, "-i");
    argv_push(&b, "pipe:0");

    append_audio_and_mp4_args(&b, cfg);
    return b.items;
}

void sr_free_argv(char **argv) {
    if (!argv) return;
    for (size_t i = 0; argv[i] != NULL; i++) {
        free(argv[i]);
    }
    free(argv);
}

void sr_make_default_mp4_filename(SrCaptureSource source, char *buf, size_t buf_size) {
    const char *tag = "screen";
    if (source == SR_SOURCE_WINDOW) tag = "window";
    else if (source == SR_SOURCE_BROWSER) tag = "tab";

    time_t now = time(NULL);
    struct tm tmv;
    localtime_r(&now, &tmv);

    snprintf(
        buf,
        buf_size,
        "screenrec-%s-%04d-%02d-%02d-%02d%02d%02d.mp4",
        tag,
        tmv.tm_year + 1900,
        tmv.tm_mon + 1,
        tmv.tm_mday,
        tmv.tm_hour,
        tmv.tm_min,
        tmv.tm_sec
    );
}

void sr_format_duration(int total_seconds, char *buf, size_t buf_size) {
    if (total_seconds < 0) total_seconds = 0;
    int hrs  = total_seconds / 3600;
    int mins = (total_seconds % 3600) / 60;
    int secs = total_seconds % 60;
    if (hrs > 0) {
        snprintf(buf, buf_size, "%02d:%02d:%02d", hrs, mins, secs);
    } else {
        snprintf(buf, buf_size, "%02d:%02d", mins, secs);
    }
}

void sr_shortcuts_init_defaults(SrShortcutConfig *cfg) {
    if (!cfg) return;
    copy_str(cfg->toggle_record, sizeof(cfg->toggle_record), "F9");
    copy_str(cfg->toggle_pause, sizeof(cfg->toggle_pause), "F10");
    copy_str(cfg->toggle_sys_audio, sizeof(cfg->toggle_sys_audio), "<Alt>s");
    copy_str(cfg->toggle_mic, sizeof(cfg->toggle_mic), "<Alt>m");
    copy_str(cfg->toggle_cursor, sizeof(cfg->toggle_cursor), "<Alt>c");
}

bool sr_shortcuts_validate_no_duplicates(const SrShortcutConfig *cfg) {
    if (!cfg) return false;
    const char *arr[5] = {
        cfg->toggle_record,
        cfg->toggle_pause,
        cfg->toggle_sys_audio,
        cfg->toggle_mic,
        cfg->toggle_cursor,
    };
    for (int i = 0; i < 5; i++) {
        if (!arr[i] || !arr[i][0]) return false;
        for (int j = i + 1; j < 5; j++) {
            if (strcasecmp(arr[i], arr[j]) == 0) return false;
        }
    }
    return true;
}

bool sr_shortcuts_load(const char *path, SrShortcutConfig *cfg) {
    if (!cfg) return false;
    sr_shortcuts_init_defaults(cfg);
    if (!path || !path[0]) return false;

    FILE *fp = fopen(path, "r");
    if (!fp) return false;

    SrShortcutConfig candidate = *cfg;
    char line[256];
    while (fgets(line, sizeof(line), fp)) {
        trim_inplace(line);
        if (!line[0] || line[0] == '#') continue;
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = '\0';
        char *key = line;
        char *val = eq + 1;
        trim_inplace(key);
        trim_inplace(val);
        if (!val[0]) continue;
        if (strcmp(key, "toggle_record") == 0) copy_str(candidate.toggle_record, sizeof(candidate.toggle_record), val);
        else if (strcmp(key, "toggle_pause") == 0) copy_str(candidate.toggle_pause, sizeof(candidate.toggle_pause), val);
        else if (strcmp(key, "toggle_sys_audio") == 0) copy_str(candidate.toggle_sys_audio, sizeof(candidate.toggle_sys_audio), val);
        else if (strcmp(key, "toggle_mic") == 0) copy_str(candidate.toggle_mic, sizeof(candidate.toggle_mic), val);
        else if (strcmp(key, "toggle_cursor") == 0) copy_str(candidate.toggle_cursor, sizeof(candidate.toggle_cursor), val);
    }
    fclose(fp);

    if (sr_shortcuts_validate_no_duplicates(&candidate)) {
        *cfg = candidate;
        return true;
    }
    return false;
}

bool sr_shortcuts_save(const char *path, const SrShortcutConfig *cfg) {
    if (!path || !cfg || !sr_shortcuts_validate_no_duplicates(cfg)) return false;
    FILE *fp = fopen(path, "w");
    if (!fp) return false;
    fprintf(fp, "# ScreenRec Native GTK3 Keyboard Shortcuts\n");
    fprintf(fp, "toggle_record=%s\n", cfg->toggle_record);
    fprintf(fp, "toggle_pause=%s\n", cfg->toggle_pause);
    fprintf(fp, "toggle_sys_audio=%s\n", cfg->toggle_sys_audio);
    fprintf(fp, "toggle_mic=%s\n", cfg->toggle_mic);
    fprintf(fp, "toggle_cursor=%s\n", cfg->toggle_cursor);
    fclose(fp);
    return true;
}
