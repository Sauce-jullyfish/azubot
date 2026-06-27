from fastapi import FastAPI,APIRouter

router = APIRouter(prefix='/api/v1')


@router.get("/health")
async def health():
    return {"message": "OK"}


app = FastAPI(
	title="azubot API",
	version="0.1.0",
	docs_url="/api/v1/docs",
	redoc_url="/api/v1/redoc",
	openapi_url="/api/v1/openapi.json",
)
app.include_router(router)
