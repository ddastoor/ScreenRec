#define _GNU_SOURCE
#include "wayland_portal.h"

#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PORTAL_BUS_NAME    "org.freedesktop.portal.Desktop"
#define PORTAL_OBJ_PATH    "/org/freedesktop/portal/desktop"
#define PORTAL_IFACE       "org.freedesktop.portal.ScreenCast"
#define PORTAL_REQ_IFACE   "org.freedesktop.portal.Request"

typedef struct {
    GMainLoop *loop;
    uint32_t   response_code;
    GVariant  *results;
    bool       completed;
} PortalCallWaiter;

static void on_portal_request_response(
    GDBusConnection *connection,
    const gchar     *sender_name,
    const gchar     *object_path,
    const gchar     *interface_name,
    const gchar     *signal_name,
    GVariant        *parameters,
    gpointer         user_data
) {
    (void)connection;
    (void)sender_name;
    (void)object_path;
    (void)interface_name;
    (void)signal_name;

    PortalCallWaiter *w = (PortalCallWaiter *)user_data;
    if (!w || w->completed) return;

    uint32_t code = 2;
    GVariant *res = NULL;
    g_variant_get(parameters, "(u@a{sv})", &code, &res);

    w->response_code = code;
    w->results       = res; /* takes ownership */
    w->completed     = true;
    if (g_main_loop_is_running(w->loop)) {
        g_main_loop_quit(w->loop);
    }
}

static gboolean on_portal_timeout(gpointer user_data) {
    PortalCallWaiter *w = (PortalCallWaiter *)user_data;
    if (w && !w->completed) {
        w->response_code = 2;
        w->completed     = true;
        if (g_main_loop_is_running(w->loop)) {
            g_main_loop_quit(w->loop);
        }
    }
    return G_SOURCE_REMOVE;
}

static void build_expected_request_path(
    GDBusConnection *conn,
    const char      *token,
    char            *out_path,
    size_t           out_sz
) {
    const char *unique = g_dbus_connection_get_unique_name(conn);
    char sanitized[128] = {0};
    if (unique) {
        size_t j = 0;
        for (size_t i = 0; unique[i] != '\0' && j + 1 < sizeof(sanitized); i++) {
            if (unique[i] == ':') continue;
            sanitized[j++] = (unique[i] == '.') ? '_' : unique[i];
        }
    }
    snprintf(
        out_path,
        out_sz,
        "/org/freedesktop/portal/desktop/request/%s/%s",
        sanitized,
        token
    );
}

bool sr_wayland_portal_open_screencast(
    SrCaptureSource        source,
    bool                   include_cursor,
    SrWaylandPortalStream *out_stream
) {
    if (!out_stream) return false;
    memset(out_stream, 0, sizeof(*out_stream));
    out_stream->pipewire_fd = -1;

    GError *err = NULL;
    GDBusConnection *conn = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &err);
    if (!conn) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Could not connect to D-Bus session bus: %s",
            err ? err->message : "unknown error"
        );
        if (err) g_error_free(err);
        return false;
    }

    unsigned int pid = (unsigned int)getpid();
    static unsigned int seq = 1;
    unsigned int cur = seq++;

    /* 1. CreateSession */
    char req_token1[64], sess_token[64], req_path1[256];
    snprintf(req_token1, sizeof(req_token1), "sr_req_%u_%u_1", pid, cur);
    snprintf(sess_token, sizeof(sess_token), "sr_sess_%u_%u", pid, cur);
    build_expected_request_path(conn, req_token1, req_path1, sizeof(req_path1));

    PortalCallWaiter w1 = { .loop = g_main_loop_new(NULL, FALSE), .response_code = 2 };
    guint sub1 = g_dbus_connection_signal_subscribe(
        conn,
        PORTAL_BUS_NAME,
        PORTAL_REQ_IFACE,
        "Response",
        req_path1,
        NULL,
        G_DBUS_SIGNAL_FLAGS_NO_MATCH_RULE,
        on_portal_request_response,
        &w1,
        NULL
    );

    GVariantBuilder opt1;
    g_variant_builder_init(&opt1, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&opt1, "{sv}", "handle_token", g_variant_new_string(req_token1));
    g_variant_builder_add(&opt1, "{sv}", "session_handle_token", g_variant_new_string(sess_token));

    GVariant *ret1 = g_dbus_connection_call_sync(
        conn,
        PORTAL_BUS_NAME,
        PORTAL_OBJ_PATH,
        PORTAL_IFACE,
        "CreateSession",
        g_variant_new("(a{sv})", &opt1),
        G_VARIANT_TYPE("(o)"),
        G_DBUS_CALL_FLAGS_NONE,
        10000,
        NULL,
        &err
    );
    if (!ret1) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "xdg-desktop-portal ScreenCast unavailable: %s",
            err ? err->message : "portal call failed"
        );
        if (err) g_error_free(err);
        g_dbus_connection_signal_unsubscribe(conn, sub1);
        g_main_loop_unref(w1.loop);
        g_object_unref(conn);
        return false;
    }
    g_variant_unref(ret1);

    guint t1 = g_timeout_add_seconds(15, on_portal_timeout, &w1);
    if (!w1.completed) g_main_loop_run(w1.loop);
    g_source_remove(t1);
    g_dbus_connection_signal_unsubscribe(conn, sub1);
    g_main_loop_unref(w1.loop);

    if (w1.response_code != 0 || !w1.results) {
        if (w1.results) g_variant_unref(w1.results);
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Wayland portal CreateSession was canceled or rejected."
        );
        g_object_unref(conn);
        return false;
    }

    const gchar *session_handle_raw = NULL;
    if (!g_variant_lookup(w1.results, "session_handle", "&s", &session_handle_raw) &&
        !g_variant_lookup(w1.results, "session_handle", "&o", &session_handle_raw)) {
        g_variant_unref(w1.results);
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Wayland portal did not return a session_handle."
        );
        g_object_unref(conn);
        return false;
    }
    char session_handle[256];
    snprintf(session_handle, sizeof(session_handle), "%s", session_handle_raw);
    g_variant_unref(w1.results);

    /* 2. SelectSources (types: 1=Monitor, 2=Window; cursor_mode: 2=Embedded, 1=Hidden) */
    char req_token2[64], req_path2[256];
    snprintf(req_token2, sizeof(req_token2), "sr_req_%u_%u_2", pid, cur);
    build_expected_request_path(conn, req_token2, req_path2, sizeof(req_path2));

    PortalCallWaiter w2 = { .loop = g_main_loop_new(NULL, FALSE), .response_code = 2 };
    guint sub2 = g_dbus_connection_signal_subscribe(
        conn,
        PORTAL_BUS_NAME,
        PORTAL_REQ_IFACE,
        "Response",
        req_path2,
        NULL,
        G_DBUS_SIGNAL_FLAGS_NO_MATCH_RULE,
        on_portal_request_response,
        &w2,
        NULL
    );

    uint32_t source_types = (source == SR_SOURCE_SCREEN) ? 1u : 2u;
    uint32_t cursor_mode  = include_cursor ? 2u : 1u;

    GVariantBuilder opt2;
    g_variant_builder_init(&opt2, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&opt2, "{sv}", "handle_token", g_variant_new_string(req_token2));
    g_variant_builder_add(&opt2, "{sv}", "types", g_variant_new_uint32(source_types));
    g_variant_builder_add(&opt2, "{sv}", "cursor_mode", g_variant_new_uint32(cursor_mode));
    g_variant_builder_add(&opt2, "{sv}", "multiple", g_variant_new_boolean(FALSE));

    GVariant *ret2 = g_dbus_connection_call_sync(
        conn,
        PORTAL_BUS_NAME,
        PORTAL_OBJ_PATH,
        PORTAL_IFACE,
        "SelectSources",
        g_variant_new("(oa{sv})", session_handle, &opt2),
        G_VARIANT_TYPE("(o)"),
        G_DBUS_CALL_FLAGS_NONE,
        10000,
        NULL,
        &err
    );
    if (!ret2) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Wayland SelectSources failed: %s",
            err ? err->message : "unknown"
        );
        if (err) g_error_free(err);
        g_dbus_connection_signal_unsubscribe(conn, sub2);
        g_main_loop_unref(w2.loop);
        g_object_unref(conn);
        return false;
    }
    g_variant_unref(ret2);

    guint t2 = g_timeout_add_seconds(15, on_portal_timeout, &w2);
    if (!w2.completed) g_main_loop_run(w2.loop);
    g_source_remove(t2);
    g_dbus_connection_signal_unsubscribe(conn, sub2);
    g_main_loop_unref(w2.loop);
    if (w2.results) g_variant_unref(w2.results);

    if (w2.response_code != 0) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Wayland portal SelectSources was rejected."
        );
        g_object_unref(conn);
        return false;
    }

    /* 3. Start (shows native KDE/GNOME Screen/Window Picker GUI dialog) */
    char req_token3[64], req_path3[256];
    snprintf(req_token3, sizeof(req_token3), "sr_req_%u_%u_3", pid, cur);
    build_expected_request_path(conn, req_token3, req_path3, sizeof(req_path3));

    PortalCallWaiter w3 = { .loop = g_main_loop_new(NULL, FALSE), .response_code = 2 };
    guint sub3 = g_dbus_connection_signal_subscribe(
        conn,
        PORTAL_BUS_NAME,
        PORTAL_REQ_IFACE,
        "Response",
        req_path3,
        NULL,
        G_DBUS_SIGNAL_FLAGS_NO_MATCH_RULE,
        on_portal_request_response,
        &w3,
        NULL
    );

    GVariantBuilder opt3;
    g_variant_builder_init(&opt3, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&opt3, "{sv}", "handle_token", g_variant_new_string(req_token3));

    GVariant *ret3 = g_dbus_connection_call_sync(
        conn,
        PORTAL_BUS_NAME,
        PORTAL_OBJ_PATH,
        PORTAL_IFACE,
        "Start",
        g_variant_new("(osa{sv})", session_handle, "", &opt3),
        G_VARIANT_TYPE("(o)"),
        G_DBUS_CALL_FLAGS_NONE,
        15000,
        NULL,
        &err
    );
    if (!ret3) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Wayland Start failed: %s",
            err ? err->message : "unknown"
        );
        if (err) g_error_free(err);
        g_dbus_connection_signal_unsubscribe(conn, sub3);
        g_main_loop_unref(w3.loop);
        g_object_unref(conn);
        return false;
    }
    g_variant_unref(ret3);

    guint t3 = g_timeout_add_seconds(90, on_portal_timeout, &w3);
    if (!w3.completed) g_main_loop_run(w3.loop);
    g_source_remove(t3);
    g_dbus_connection_signal_unsubscribe(conn, sub3);
    g_main_loop_unref(w3.loop);

    if (w3.response_code != 0 || !w3.results) {
        if (w3.results) g_variant_unref(w3.results);
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Screen or window selection was canceled."
        );
        g_object_unref(conn);
        return false;
    }

    uint32_t node_id = 0;
    bool got_node = false;
    GVariant *streams_var = g_variant_lookup_value(w3.results, "streams", G_VARIANT_TYPE("a(ua{sv})"));
    if (streams_var) {
        GVariantIter iter;
        g_variant_iter_init(&iter, streams_var);
        GVariant *props = NULL;
        if (g_variant_iter_next(&iter, "(u@a{sv})", &node_id, &props)) {
            got_node = true;
            if (props) g_variant_unref(props);
        }
        g_variant_unref(streams_var);
    }
    g_variant_unref(w3.results);

    if (!got_node) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Wayland portal did not return any PipeWire stream node."
        );
        g_object_unref(conn);
        return false;
    }

    /* 4. OpenPipeWireRemote -> acquire PipeWire file descriptor */
    GVariantBuilder opt4;
    g_variant_builder_init(&opt4, G_VARIANT_TYPE_VARDICT);
    GUnixFDList *fd_list = NULL;

    GVariant *ret4 = g_dbus_connection_call_with_unix_fd_list_sync(
        conn,
        PORTAL_BUS_NAME,
        PORTAL_OBJ_PATH,
        PORTAL_IFACE,
        "OpenPipeWireRemote",
        g_variant_new("(oa{sv})", session_handle, &opt4),
        G_VARIANT_TYPE("(h)"),
        G_DBUS_CALL_FLAGS_NONE,
        10000,
        NULL,
        &fd_list,
        NULL,
        &err
    );
    if (!ret4 || !fd_list) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "OpenPipeWireRemote failed: %s",
            err ? err->message : "no fd list"
        );
        if (err) g_error_free(err);
        if (ret4) g_variant_unref(ret4);
        if (fd_list) g_object_unref(fd_list);
        g_object_unref(conn);
        return false;
    }

    gint32 fd_index = 0;
    g_variant_get(ret4, "(h)", &fd_index);
    g_variant_unref(ret4);

    int pw_fd = g_unix_fd_list_get(fd_list, fd_index, &err);
    g_object_unref(fd_list);
    g_object_unref(conn);

    if (pw_fd < 0) {
        snprintf(
            out_stream->error_message,
            sizeof(out_stream->error_message),
            "Failed to extract PipeWire file descriptor: %s",
            err ? err->message : "invalid fd"
        );
        if (err) g_error_free(err);
        return false;
    }

    out_stream->pipewire_fd = pw_fd;
    out_stream->node_id     = node_id;
    return true;
}
