import {
  applyPublishedPostToState,
  isPostableIssue,
  isOwnMoltbookPost,
  markMoltbookCommentProcessed,
  findPreviewDraft,
  mergeSchedulerStateForWrite,
  previewDraftId,
  publicationStatusOf,
  recordMoltbookReplyFailure,
} from '../src/services/moltbookScheduler.js';

describe('Moltbook reviewed preview selection', () => {
  it('creates a stable ID from the exact reviewed draft', () => {
    const post = {
      submolt: 'general',
      title: 'A grounded title',
      content: 'A grounded body?',
      evidence: 'A concrete corpus sentence.',
      learningCorpusHash: 'corpus-1',
    };

    expect(previewDraftId(post)).toBe(previewDraftId({ ...post }));
    expect(previewDraftId({ ...post, content: 'A changed body?' })).not.toBe(previewDraftId(post));
  });

  it('returns only the exact unexpired reviewed draft', () => {
    const state = {
      previewDrafts: [
        { draftId: 'live-draft', expiresAt: 2000, title: 'Use this' },
        { draftId: 'expired-draft', expiresAt: 999, title: 'Do not use this' },
      ],
    };

    expect(findPreviewDraft(state, 'live-draft', 1000)).toMatchObject({ title: 'Use this' });
    expect(findPreviewDraft(state, 'expired-draft', 1000)).toBeNull();
    expect(findPreviewDraft(state, 'missing-draft', 1000)).toBeNull();
  });
});

describe('Moltbook isolated state persistence', () => {
  const current = {
    pendingVerifications: [{ post_id: 'pending-post', verification_code: 'code-1' }],
    previewDrafts: [{ draftId: 'reviewed-draft' }],
    postsTotal: 8,
  };

  it('prevents a stale scheduler snapshot from clearing verification cards or reviewed drafts', () => {
    const staleActivityState = {
      pendingVerifications: [],
      previewDrafts: [],
      postsTotal: 9,
    };

    expect(mergeSchedulerStateForWrite(staleActivityState, current)).toEqual({
      pendingVerifications: current.pendingVerifications,
      previewDrafts: current.previewDrafts,
      postsTotal: 9,
    });
  });

  it('allows only the owning queue operation to clear its isolated field', () => {
    const next = { pendingVerifications: [], previewDrafts: [], postsTotal: 9 };

    expect(mergeSchedulerStateForWrite(next, current, ['pendingVerifications'])).toMatchObject({
      pendingVerifications: [],
      previewDrafts: current.previewDrafts,
    });
    expect(mergeSchedulerStateForWrite(next, current, ['previewDrafts'])).toMatchObject({
      pendingVerifications: current.pendingVerifications,
      previewDrafts: [],
    });
  });
});

describe('Moltbook issue publication gate', () => {
  it('rejects empty issue descriptions', () => {
    expect(isPostableIssue({ description: '', posted: false })).toBe(false);
  });

  it.each([
    'self_awareness: deferred; read_event_log: deferred',
    'fs_find: denied; fs_find: denied',
    'fs_read: error; fs_read: error',
    'query required',
  ])('rejects low-information internal receipts: %s', description => {
    expect(isPostableIssue({
      description,
      posted: false,
      occurrences: 50,
      context: { source: 'agent-error' },
    })).toBe(false);
  });

  it('waits for repeated autonomous failures before making them public', () => {
    const issue = {
      description: 'The same tool failed while completing a verified workflow stage.',
      posted: false,
      occurrences: 2,
      context: { source: 'agent-error' },
    };
    expect(isPostableIssue(issue)).toBe(false);
    expect(isPostableIssue({ ...issue, occurrences: 3 })).toBe(true);
  });

  it('allows a deliberately tracked human issue immediately', () => {
    expect(isPostableIssue({ description: 'Please help diagnose this reproducible issue.', posted: false })).toBe(true);
  });
});

describe('Moltbook own-post identity gate', () => {
  it('accepts only the configured agent as an own-post author', () => {
    expect(isOwnMoltbookPost({ author: { name: 'AVA-Voice' } })).toBe(true);
    expect(isOwnMoltbookPost({ author: { name: 'ava-voice' } })).toBe(true);
    expect(isOwnMoltbookPost({ author: { name: 'diviner' } })).toBe(false);
    expect(isOwnMoltbookPost({})).toBe(false);
  });
});

describe('Moltbook grounded reply retries', () => {
  it('retries rejected drafts before recording an explicit safety skip', () => {
    const state = { processedComments: [] };

    expect(recordMoltbookReplyFailure(state, 'post-comment', 'ungrounded', 3)).toEqual({
      attempts: 1,
      exhausted: false,
    });
    expect(recordMoltbookReplyFailure(state, 'post-comment', 'ungrounded', 3)).toEqual({
      attempts: 2,
      exhausted: false,
    });
    expect(state.processedComments).toEqual([]);

    expect(recordMoltbookReplyFailure(state, 'post-comment', 'ungrounded', 3)).toEqual({
      attempts: 3,
      exhausted: true,
    });
    expect(state.processedComments).toEqual(['post-comment']);
    expect(state.commentReplyAttempts['post-comment']).toBeUndefined();
    expect(state.skippedCommentReplies).toEqual([
      expect.objectContaining({ commentKey: 'post-comment', reason: 'ungrounded', attempts: 3 }),
    ]);
  });

  it('clears a prior failure record after a reply succeeds', () => {
    const state = { processedComments: [] };
    recordMoltbookReplyFailure(state, 'post-comment', 'ungrounded', 3);

    markMoltbookCommentProcessed(state, 'post-comment');
    markMoltbookCommentProcessed(state, 'post-comment');

    expect(state.processedComments).toEqual(['post-comment']);
    expect(state.commentReplyAttempts['post-comment']).toBeUndefined();
  });
});

describe('Moltbook publication accounting', () => {
  it('does not count an accepted challenge as published before verification', () => {
    expect(publicationStatusOf({
      success: true,
      post: {
        id: 'pending-post',
        verification_status: 'pending',
        verification: { verification_code: 'verify-1', challenge_text: 'challenge' },
      },
    })).toBe('pending_verification');

    expect(publicationStatusOf({
      success: true,
      post: { id: 'verified-post', verification_status: 'verified' },
    })).toBe('published');
  });

  it('records a verified self-post exactly once', () => {
    const state = {
      recentPosts: [],
      postsToday: 7,
      postsDate: 'the previous day',
      postsTotal: 9,
      selfPostsTotal: 4,
    };
    const publication = {
      post_id: 'verified-post',
      submolt: 'general',
      title: 'A verified post',
      kind: 'self',
      publishedAt: 123456,
    };

    expect(applyPublishedPostToState(state, publication)).toBe(true);
    expect(applyPublishedPostToState(state, publication)).toBe(false);
    expect(state).toMatchObject({
      postsToday: 1,
      postsDate: new Date(123456).toDateString(),
      postsTotal: 10,
      selfPostsTotal: 5,
      verifiedPostsTotal: 1,
      verifiedSelfPostsTotal: 1,
      lastPostAt: 123456,
      lastSelfPostAt: 123456,
    });
    expect(state.recentPosts).toEqual([expect.objectContaining({ id: 'verified-post', verified: true })]);
  });
});
