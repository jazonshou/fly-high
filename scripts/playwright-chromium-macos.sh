#!/bin/sh

set -eu

chromium_executable="${FLIGHT_SIM_PLAYWRIGHT_CHROMIUM_EXECUTABLE:?missing Chromium executable}"

if [ ! -x "$chromium_executable" ]; then
  echo "Chromium executable is not runnable: $chromium_executable" >&2
  exit 127
fi

# Playwright uses descriptors 3/4 for CDP. Redirect only stderr so detached
# crashpad helpers cannot keep Playwright's child-process pipe open on macOS.
exec "$chromium_executable" "$@" 2>/dev/null
