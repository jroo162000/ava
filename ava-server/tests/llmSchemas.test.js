import { llmSchemaInternals } from '../src/services/llm.js';

const fileTool = {
  type: 'function',
  function: {
    name: 'file_gen',
    description: 'Create a file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        filename: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['content'],
      anyOf: [{ required: ['file_path'] }, { required: ['filename'] }],
    },
  },
};

const jsonTool = {
  type: 'function',
  function: {
    name: 'json_ops',
    description: 'Process JSON.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['parse', 'stringify'] },
        data: { type: ['string', 'object'], description: 'JSON input.' },
      },
      required: ['operation'],
    },
  },
};

describe('portable cloud tool schemas', () => {
  test('removes top-level unions while retaining their requirement as model guidance', () => {
    const [tool] = llmSchemaInternals.toolsForOpenAI([fileTool]);
    expect(tool.function.parameters).not.toHaveProperty('anyOf');
    expect(tool.function.parameters.required).toEqual(['content']);
    expect(tool.function.parameters.description).toMatch(/file_path or filename/i);
  });

  test('normalizes multi-type properties to a provider-safe scalar type', () => {
    const [openai] = llmSchemaInternals.toolsForOpenAI([jsonTool]);
    const [geminiGroup] = llmSchemaInternals.toolsForGemini([jsonTool]);
    const gemini = geminiGroup.functionDeclarations[0];
    expect(openai.function.parameters.properties.data.type).toBe('string');
    expect(openai.function.parameters.properties.data.description).toMatch(/string or object/i);
    expect(gemini.parameters.properties.data.type).toBe('string');
  });

  test('produces portable schemas for OpenAI-compatible, Claude, and Gemini APIs', () => {
    const outputs = [
      llmSchemaInternals.toolsForOpenAI([fileTool, jsonTool]),
      llmSchemaInternals.toolsForClaude([fileTool, jsonTool]),
      llmSchemaInternals.toolsForGemini([fileTool, jsonTool]),
    ];
    for (const output of outputs) {
      const json = JSON.stringify(output);
      expect(json).not.toMatch(/oneOf|anyOf|allOf/);
      expect(json).not.toMatch(/"type":\[/);
    }
  });

  test('does not mutate the registry schemas', () => {
    const before = JSON.stringify([fileTool, jsonTool]);
    llmSchemaInternals.toolsForOpenAI([fileTool, jsonTool]);
    llmSchemaInternals.toolsForClaude([fileTool, jsonTool]);
    llmSchemaInternals.toolsForGemini([fileTool, jsonTool]);
    expect(JSON.stringify([fileTool, jsonTool])).toBe(before);
  });
});
