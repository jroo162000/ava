"""
AVA FIX: Deepgram Agent Google Gemini Endpoint Configuration

The issue is that the build_settings_with_provider function is missing the required
endpoint configuration for Google Gemini. Deepgram does NOT manage Google's LLMs,
so you MUST provide an endpoint URL with the Gemini API key.

INSTRUCTIONS:
1. Stop AVA (Ctrl+C or close the terminal)
2. Open ava_standalone_realtime.py
3. Find the function: def build_settings_with_provider(provider_name, provider_class, model_name):
4. Replace the ENTIRE function with the fixed version below
5. Save and restart AVA

FIXED FUNCTION (copy everything between the === markers):
============================================================
"""

# FIXED build_settings_with_provider function - REPLACE THE EXISTING ONE WITH THIS:

def build_settings_with_provider(provider_name, provider_class, model_name):
    """Helper to build settings with a specific think provider"""
    # Determine provider type string based on class
    if provider_class == AgentV1GoogleThinkProvider:
        provider_type = "google"
    elif provider_class == AgentV1AnthropicThinkProvider:
        provider_type = "anthropic"
    elif provider_class == AgentV1OpenAiThinkProvider:
        provider_type = "open_ai"  # NOTE: Must be "open_ai" not "openai"
    elif provider_class == AgentV1GroqThinkProvider:
        provider_type = "groq"
    else:
        provider_type = "unknown"

    # Build endpoint for providers that REQUIRE it (Google, Groq)
    # Deepgram manages OpenAI and Anthropic, so no endpoint needed for them
    think_endpoint = None
    if provider_type == "google" and self.gemini_key:
        # Google Gemini REQUIRES endpoint with model in URL
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:streamGenerateContent?alt=sse"
        think_endpoint = AgentV1Endpoint(
            url=gemini_url,
            headers={"x-goog-api-key": self.gemini_key}
        )
        print(f"[agent] Using Gemini endpoint: {gemini_url[:60]}...")
    elif provider_type == "groq" and self.groq_key:
        # Groq also requires endpoint
        think_endpoint = AgentV1Endpoint(
            url="https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.groq_key}"}
        )
        print(f"[agent] Using Groq endpoint")

    # Build think config with or without endpoint
    if think_endpoint:
        think_config = AgentV1Think(
            provider=provider_class(type=provider_type, model=model_name),
            endpoint=think_endpoint,
            prompt=prompt_text,
            functions=dg_functions
        )
    else:
        think_config = AgentV1Think(
            provider=provider_class(type=provider_type, model=model_name),
            prompt=prompt_text,
            functions=dg_functions
        )

    return AgentV1SettingsMessage(
        audio=AgentV1AudioConfig(
            input=AgentV1AudioInput(encoding="linear16", sample_rate=MIC_RATE),
            output=AgentV1AudioOutput(encoding="linear16", sample_rate=24000, container="wav")
        ),
        agent=AgentV1Agent(
            listen=AgentV1Listen(
                provider=AgentV1ListenProvider(type="deepgram", model=str(self.cfg.get('asr_model','nova-2')))
            ),
            think=think_config,
            speak=AgentV1SpeakProviderConfig(
                provider=AgentV1DeepgramSpeakProvider(type="deepgram", model=str(self.cfg.get('tts_model','aura-2-andromeda-en')))
            )
        )
    )

"""
============================================================
END OF FIXED FUNCTION

ALSO: Make sure AgentV1Endpoint is in your imports at the top of the file.
Look for the imports section and add it if missing:

from deepgram.extensions.types.sockets import (
    AgentV1Agent,
    AgentV1AudioConfig,
    AgentV1AudioInput,
    AgentV1AudioOutput,
    AgentV1DeepgramSpeakProvider,
    AgentV1Endpoint,  # <-- MAKE SURE THIS IS HERE
    AgentV1GoogleThinkProvider,
    ...
)
"""
