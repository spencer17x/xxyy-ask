from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: str = ""
    openai_model: str = "gpt-5.5"
    openai_embedding_model: str = "text-embedding-3-small"
    xxyy_docs_base_url: str = "https://docs.xxyy.io"
    langsmith_tracing: bool = False
    langsmith_project: str = "xxyy-ask"


@lru_cache
def get_settings() -> Settings:
    return Settings()

