#ifndef SCREENREC_WAYLAND_PORTAL_H
#define SCREENREC_WAYLAND_PORTAL_H

#include <stdbool.h>
#include <stdint.h>
#include "core.h"

typedef struct {
    int      pipewire_fd;
    uint32_t node_id;
    char     error_message[256];
} SrWaylandPortalStream;

/*
 * Opens a native Wayland screencast session via org.freedesktop.portal.ScreenCast
 * (KDE Plasma / GNOME / wlroots desktop portal):
 * - Prompts the user with the native OS GUI screen/window picker (no CLI needed)
 * - Passes cursor_mode = 2 (Embedded) when include_cursor is true, or 1 (Hidden) when false
 * - Returns true with an open PipeWire UNIX fd and PipeWire node_id on success
 */
bool sr_wayland_portal_open_screencast(
    SrCaptureSource        source,
    bool                   include_cursor,
    SrWaylandPortalStream *out_stream
);

#endif /* SCREENREC_WAYLAND_PORTAL_H */
