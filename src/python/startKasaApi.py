import os
import signal
import stat
import sys
import threading
import time
import uvicorn

def log(message: str, level: str = "INFO"):
    print(f"[Kasa API] {level}: {message}", file=sys.stdout if level != "ERROR" else sys.stderr)

def exit_with_parent():
    """Stop when the plugin's process is gone, however it ended, so the service never runs on its own."""
    parent = os.getppid()
    try:
        mode = os.fstat(sys.stdin.fileno()).st_mode
        stdin_is_pipe = stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)
    except (OSError, ValueError):
        stdin_is_pipe = False

    def watch():
        if stdin_is_pipe:
            # The plugin holds the other end of stdin and never writes to it; it closes when its process ends.
            try:
                while sys.stdin.buffer.read(65536):
                    pass
            except (OSError, ValueError):
                pass
        else:
            while os.getppid() == parent:
                time.sleep(5)
        # Uvicorn shuts down on SIGTERM; if that hangs, leave anyway.
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(5)
        os._exit(1)

    threading.Thread(target=watch, name="exit-with-parent", daemon=True).start()

def start_api(port: int, hideHomeKitMatter: bool):
    try:
        log("Starting Kasa API...")

        os.environ["HIDE_HOMEKIT_MATTER"] = "true" if hideHomeKitMatter else "false"

        # Only the plugin talks to the service, always over 127.0.0.1 and with its token.
        uvicorn.run(
            "kasaApi:app",
            host="127.0.0.1",
            port=port,
            loop="asyncio",
            workers=1,
            timeout_keep_alive=120,
            limit_concurrency=1000,
        )
    except Exception as e:
        log(f"Failed to start Kasa API: {e}", level="ERROR")
        sys.exit(1)

if __name__ == '__main__':
    try:
        port = int(sys.argv[1])
        hideHomeKitMatter = sys.argv[2].lower() == "true"
        if not os.environ.get("KASA_API_TOKEN"):
            log("KASA_API_TOKEN is not set; the plugin starts this service with it", level="ERROR")
            sys.exit(1)
        exit_with_parent()
        start_api(port, hideHomeKitMatter)
    except IndexError:
        log("Missing arguments: python startKasaApi.py <port> <hideHomeKitMatter>", level="ERROR")
        sys.exit(1)