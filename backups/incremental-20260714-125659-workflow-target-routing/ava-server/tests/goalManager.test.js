import goalManager from '../src/services/goalManager.js';

const { isConversationOnly, shouldClassify } = goalManager._internals;

describe('goal manager conversation routing', () => {
  test('keeps the logged upgrade-reflection request out of the workflow engine', () => {
    const text = 'you just had a long run of upgrades completed tell me what you think about them some more are coming in now';
    expect(isConversationOnly(text)).toBe(true);
    expect(shouldClassify(text)).toBe(false);
  });

  test('does not hide requested work behind the dialogue guard', () => {
    const text = 'Tell me what you think about these changes, then inspect the failures and fix what is broken.';
    expect(isConversationOnly(text)).toBe(false);
    expect(shouldClassify(text)).toBe(true);
  });

  test('still classifies broad long-horizon work', () => {
    expect(shouldClassify('Run a full audit of the entire repo and implement all verified recommendations from start to finish.')).toBe(true);
  });
});
