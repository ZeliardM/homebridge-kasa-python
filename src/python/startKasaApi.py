import sys
import uvicorn

if __name__ == '__main__':
    port = int(sys.argv[1])
    uvicorn.run(
        "kasaApi:app",
        host="0.0.0.0",
        port=port,
        loop="asyncio",
        workers=4,
        timeout_keep_alive=120,
        limit_concurrency=1000,
    )