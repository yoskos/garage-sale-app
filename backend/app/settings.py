from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    anthropic_api_key: str
    shared_secret: str
    database_path: str = "./garage_sale.db"
    cache_dir: str = "./image_cache"
    port: int = 8000
    rate_limit_rpm: int = 30


settings = Settings()
