ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
DESKTOP_DIR := $(ROOT)/apps/desktop

# Options (override on the command line, e.g. `make local-build BOOTSTRAP=1 SMOKE=0`)
BOOTSTRAP ?= 0
SMOKE ?= 1
PORT ?= 4789

.DEFAULT_GOAL := help

# macOS ships GNU Make 3.81, which has no `.ONESHELL`. Each recipe is therefore
# a single `bash -c` invocation of a composed, exported script variable so the
# multi-line shell logic runs in one shell.

# Shared shell prelude: resolve platform, revision, and a die helper.
define PRELUDE
ROOT="$(ROOT)"
DESKTOP_DIR="$(DESKTOP_DIR)"
die() { echo "error: $$*" >&2; exit 1; }
revision() {
  if command -v jj >/dev/null 2>&1 && jj root >/dev/null 2>&1; then
    jj log -r @ --no-graph -T commit_id 2>/dev/null
  else
    git -C "$$ROOT" rev-parse HEAD
  fi
}
[[ $$(uname -s) == Darwin ]] || die "this target only supports macOS"
ARCH=$$(uname -m)
if [[ "$$ARCH" == x86_64 ]] && [[ $$(sysctl -n sysctl.proc_translated 2>/dev/null || true) == 1 ]]; then
  ARCH=arm64
fi
case "$$ARCH" in
  arm64) BUN_TARGET=bun-darwin-arm64; APP_OUTPUT=mac-arm64 ;;
  x86_64) ARCH=x64; BUN_TARGET=bun-darwin-x64; APP_OUTPUT=mac ;;
  *) die "unsupported architecture: $$ARCH" ;;
esac
endef

# Build the sidecar (and optionally bootstrap / smoke test).
define BUILD_SIDECAR
REVISION=$$(revision)
echo "Building revision $$REVISION ($$ARCH)"
if [[ "$(BOOTSTRAP)" != 0 ]]; then
  bun run --cwd "$$ROOT" bootstrap
fi
(
  cd "$$DESKTOP_DIR"
  BUN_TARGET="$$BUN_TARGET" bun ./scripts/build-sidecar.ts
  if [[ "$(SMOKE)" != 0 ]]; then
    bun run test:smoke
  fi
)
endef

# Guard: the working copy must not have changed during the build.
define GUARD
[[ $$(revision) == "$$REVISION" ]] || die "the working-copy revision changed during the build; rerun"
endef

# Replace and restart the supervised CLI backend.
define REPLACE_BACKEND
BACKEND_SOURCE="$$ROOT/apps/cli/dist/executor-darwin-$$ARCH/bin"
[[ -x "$$BACKEND_SOURCE/executor" ]] || die "backend build is missing"
PLIST="$$HOME/Library/LaunchAgents/sh.executor.daemon.plist"
[[ -f "$$PLIST" ]] || die "the supervised service is not installed; run executor service install first"
DEST_EXEC=$$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$$PLIST")
DEST_DIR=$$(dirname "$$DEST_EXEC")
PORT=$$(/usr/bin/plutil -extract ProgramArguments.5 raw -o - "$$PLIST")
OLD_PID=$$(launchctl print "gui/$$(id -u)/sh.executor.daemon" 2>/dev/null | awk '/^[[:space:]]*pid = / {print $$3; exit}')
if [[ "$$DEST_DIR" != "$$BACKEND_SOURCE" ]]; then
  TEMP="$$DEST_DIR.local-new"
  BACKUP="$$DEST_DIR.local-backup"
  rm -rf "$$TEMP" "$$BACKUP"
  ditto "$$BACKEND_SOURCE" "$$TEMP"
  chmod 755 "$$TEMP/executor" "$$TEMP/workerd"
  mv "$$DEST_DIR" "$$BACKUP"
  if ! mv "$$TEMP" "$$DEST_DIR"; then
    mv "$$BACKUP" "$$DEST_DIR"
    die "could not install backend"
  fi
else
  BACKUP=""
fi
if ! "$$BACKEND_SOURCE/executor" service restart; then
  if [[ -n "$$BACKUP" ]]; then
    rm -rf "$$DEST_DIR"; mv "$$BACKUP" "$$DEST_DIR"
    "$$DEST_DIR/executor" service restart || true
  fi
  die "could not restart backend"
fi
NEW_PID=""
for _ in $$(seq 1 100); do
  NEW_PID=$$(launchctl print "gui/$$(id -u)/sh.executor.daemon" 2>/dev/null | awk '/^[[:space:]]*pid = / {print $$3; exit}')
  if [[ -n "$$NEW_PID" && "$$NEW_PID" != "$$OLD_PID" ]] && \
    curl -fsS "http://127.0.0.1:$$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if [[ -z "$$NEW_PID" || "$$NEW_PID" == "$$OLD_PID" ]] || \
  ! curl -fsS "http://127.0.0.1:$$PORT/api/health" >/dev/null 2>&1; then
  if [[ -n "$$BACKUP" ]]; then
    rm -rf "$$DEST_DIR"; mv "$$BACKUP" "$$DEST_DIR"
    "$$DEST_DIR/executor" service restart || true
  fi
  die "new backend did not become healthy"
fi
[[ -z "$$BACKUP" ]] || rm -rf "$$BACKUP"
echo "Backend replaced: pid $$OLD_PID -> $$NEW_PID, health ok"
endef

# Build and replace the desktop app.
define REPLACE_DESKTOP
(
  cd "$$DESKTOP_DIR"
  bunx --bun electron-vite build
  # Only the unpacked .app is consumed below; `dir` skips the flaky dmg/zip
  # packaging targets from electron-builder.config.ts.
  bunx --bun electron-builder --mac dir "--$$ARCH" --publish never \
    --config electron-builder.config.ts
)
SOURCE_APP="$$DESKTOP_DIR/dist/$$APP_OUTPUT/Executor.app"
TARGET_APP=/Applications/Executor.app
BACKUP_APP=/Applications/Executor.app.local-backup
[[ -d "$$SOURCE_APP" ]] || die "desktop build is missing: $$SOURCE_APP"
OLD_APP_PID=$$(pgrep -f '^/Applications/Executor.app/Contents/MacOS/Executor$$' || true)
osascript -e 'tell application "Executor" to quit' >/dev/null 2>&1 || true
for _ in $$(seq 1 50); do
  pgrep -f '^/Applications/Executor.app/Contents/MacOS/Executor$$' >/dev/null || break
  sleep 0.2
done
if pgrep -f '^/Applications/Executor.app/Contents/MacOS/Executor$$' >/dev/null; then
  pkill -TERM -f '^/Applications/Executor.app/Contents/MacOS/Executor$$' || true
  for _ in $$(seq 1 25); do
    pgrep -f '^/Applications/Executor.app/Contents/MacOS/Executor$$' >/dev/null || break
    sleep 0.2
  done
fi
pgrep -f '^/Applications/Executor.app/Contents/MacOS/Executor$$' >/dev/null && \
  die "could not stop the current desktop process"
rm -rf "$$BACKUP_APP"
[[ ! -d "$$TARGET_APP" ]] || mv "$$TARGET_APP" "$$BACKUP_APP"
if ! ditto "$$SOURCE_APP" "$$TARGET_APP"; then
  rm -rf "$$TARGET_APP"
  [[ ! -d "$$BACKUP_APP" ]] || mv "$$BACKUP_APP" "$$TARGET_APP"
  die "could not install desktop app"
fi
open "$$TARGET_APP"
NEW_APP_PID=""
for _ in $$(seq 1 50); do
  NEW_APP_PID=$$(pgrep -f '^/Applications/Executor.app/Contents/MacOS/Executor$$' || true)
  [[ -z "$$NEW_APP_PID" ]] || break
  sleep 0.2
done
if [[ -z "$$NEW_APP_PID" || "$$NEW_APP_PID" == "$$OLD_APP_PID" ]]; then
  rm -rf "$$TARGET_APP"
  if [[ -d "$$BACKUP_APP" ]]; then
    mv "$$BACKUP_APP" "$$TARGET_APP"; open "$$TARGET_APP"
  fi
  die "new desktop app did not remain running"
fi
codesign --verify --deep --strict "$$TARGET_APP"
rm -rf "$$BACKUP_APP"
echo "Desktop replaced: pid $${OLD_APP_PID:-none} -> $$NEW_APP_PID"
endef

# Composed, exported scripts run as a single `bash -c` per target.
export LOCAL_BUILD_SH
define LOCAL_BUILD_SH
$(PRELUDE)
$(BUILD_SIDECAR)
$(GUARD)
$(REPLACE_BACKEND)
$(REPLACE_DESKTOP)
echo "Installed revision $$REVISION"
endef

export LOCAL_BACKEND_SH
define LOCAL_BACKEND_SH
$(PRELUDE)
$(BUILD_SIDECAR)
$(GUARD)
$(REPLACE_BACKEND)
echo "Installed revision $$REVISION"
endef

export LOCAL_DESKTOP_SH
define LOCAL_DESKTOP_SH
$(PRELUDE)
$(BUILD_SIDECAR)
$(GUARD)
$(REPLACE_DESKTOP)
echo "Installed revision $$REVISION"
endef

export DEV_SH
define DEV_SH
cd "$(ROOT)"
executor service uninstall
EXECUTOR_DEV=1 \
  EXECUTOR_DATA_DIR="$$HOME/.executor" \
  EXECUTOR_SCOPE_DIR="$$HOME/.executor" \
  bun run apps/cli/src/main.ts web --foreground --port $(PORT)
endef

.PHONY: help local-build local-backend local-desktop dev

help:
	@echo "Executor local build targets (macOS only):"
	@echo ""
	@echo "  make local-build      Build and replace both backend and desktop"
	@echo "  make local-backend    Build and replace only the supervised CLI backend"
	@echo "  make local-desktop    Build and replace only /Applications/Executor.app"
	@echo "  make dev              Run the web dev server in the foreground"
	@echo ""
	@echo "Options:"
	@echo "  BOOTSTRAP=1           Run \`bun run bootstrap\` before building (default 0)"
	@echo "  SMOKE=0               Skip the bundled-backend smoke test (default 1)"
	@echo "  PORT=4789             Dev server port (default 4789)"

# Replace and restart both backend and desktop from the current working tree.
local-build:
	@bash -euo pipefail -c "$$LOCAL_BUILD_SH"

# Replace and restart only the supervised CLI backend.
local-backend:
	@bash -euo pipefail -c "$$LOCAL_BACKEND_SH"

# Replace and relaunch only /Applications/Executor.app.
local-desktop:
	@bash -euo pipefail -c "$$LOCAL_DESKTOP_SH"

# Run the web dev server in the foreground against a local data dir.
dev:
	@bash -euo pipefail -c "$$DEV_SH"
