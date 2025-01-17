import os, sys, uvicorn

def start_api(port: int, hideHomeKitMatter: bool):
    try:
        print("Starting Kasa Api...")

        os.environ["HIDE_HOMEKIT_MATTER"] = "true" if hideHomeKitMatter else "false"

        uvicorn.run(
            "kasaApi:app",
            host="0.0.0.0",
            port=port,
            loop="asyncio",
            workers=1,
            timeout_keep_alive=120,
            limit_concurrency=1000,
            reload=True
        )
    except Exception as e:
        print(f"Failed to start Kasa Api: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    port = int(sys.argv[1])
    hideHomeKitMatter = sys.argv[2].lower == "true"
    start_api(port, hideHomeKitMatter)