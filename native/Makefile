CC       ?= gcc
PKG_CFG  ?= pkg-config
CFLAGS   := -std=c11 -O2 -Wall -Wextra -Wno-deprecated-declarations -DHAVE_X11
GTK_CFLAGS := $(shell $(PKG_CFG) --cflags gtk+-3.0 gio-unix-2.0 x11)
GTK_LIBS   := $(shell $(PKG_CFG) --libs gtk+-3.0 gio-unix-2.0 x11)
X11_CFLAGS := $(shell $(PKG_CFG) --cflags x11)
X11_LIBS   := $(shell $(PKG_CFG) --libs x11)

BIN_DIR  := bin
APP_BIN  := $(BIN_DIR)/screenrec
TEST_BIN := $(BIN_DIR)/test_native_core

.PHONY: all clean test

all: $(APP_BIN)

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(APP_BIN): src/main.c src/core.c src/wayland_portal.c src/core.h src/wayland_portal.h | $(BIN_DIR)
	$(CC) $(CFLAGS) $(GTK_CFLAGS) -o $(APP_BIN) src/main.c src/core.c src/wayland_portal.c $(GTK_LIBS)
	strip --strip-unneeded $(APP_BIN)

$(TEST_BIN): tests/test_native_core.c src/core.c src/core.h | $(BIN_DIR)
	$(CC) $(CFLAGS) $(X11_CFLAGS) -o $(TEST_BIN) tests/test_native_core.c src/core.c $(X11_LIBS)

test: $(APP_BIN) $(TEST_BIN)
	./$(TEST_BIN)
	@sh -c 'Xvfb :96 -screen 0 1280x800x24 -nolisten tcp -ac >/dev/null 2>&1 & XPID=$$!; trap "kill $$XPID 2>/dev/null || true" EXIT; sleep 0.6; DISPLAY=:96 ./$(APP_BIN) --gui-self-test $(BIN_DIR)/gtk-selftest.png'
	@echo "[OK] Native GTK3 GUI self-test & X11grab MP4 capture verified."

clean:
	rm -rf $(BIN_DIR)
