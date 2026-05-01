from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    anthropic_api_key: str
    shared_secret: str
    database_path: str = "./garage_sale.db"
    cache_dir: str = "./image_cache"
    port: int = 8000
    rate_limit_rpm: int = 30
    # Comma-separated list of allowed CORS origins.
    # Override in .env for local dev: CORS_ORIGINS=http://localhost:5500
    cors_origins: str = "https://garage.yoskos.com"


settings = Settings()
