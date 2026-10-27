import os
import sys
import uvicorn

def log(message: str, level: str = "INFO"):
    print(f"[Kasa API] {level}: {message}", file=sys.stdout if level != "ERROR" else sys.stderr)

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
        start_api(port, hideHomeKitMatter)
    except IndexError:
        log("Missing arguments: python startKasaApi.py <port> <hideHomeKitMatter>", level="ERROR")
        sys.exit(1)