import sys
sys.path.insert(0, r"C:\Users\USER 1\cmp-use")

from cmpuse.secrets import load_into_env
from openai import OpenAI
import json

# Load secrets
load_into_env()

# Create client
client = OpenAI()

# Get all models
models = client.models.list()

# Filter GPT and o1 models
gpt_models = sorted([m.id for m in models.data if 'gpt' in m.id.lower() or 'o1' in m.id or 'o3' in m.id])

print("Available GPT/O1/O3 Models:")
print(json.dumps(gpt_models, indent=2))
