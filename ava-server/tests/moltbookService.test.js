import { jest } from '@jest/globals';
import moltbookService from '../src/services/moltbook.js';

describe('Moltbook own-post discovery', () => {
  let originalApiRequest;

  beforeEach(() => {
    originalApiRequest = moltbookService.apiRequest;
  });

  afterEach(() => {
    moltbookService.apiRequest = originalApiRequest;
  });

  it('uses the profile posts endpoint and excludes posts by other agents', async () => {
    moltbookService.apiRequest = jest.fn().mockResolvedValue({
      success: true,
      posts: [
        { id: 'ava-post', author: { name: 'AVA-Voice' } },
        { id: 'foreign-post', author: { name: 'ulagent' } },
      ],
    });

    await expect(moltbookService.getMyPosts(20)).resolves.toEqual([
      expect.objectContaining({ id: 'ava-post' }),
    ]);
    expect(moltbookService.apiRequest).toHaveBeenCalledWith('posts?author=AVA-Voice&sort=new&limit=20');
  });

  it('fails closed when a broad search returns only another agent', async () => {
    moltbookService.apiRequest = jest.fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({
        success: true,
        results: [{ post: { id: 'foreign-post', author: { name: 'ulagent' } } }],
      });

    await expect(moltbookService.getMyPosts()).resolves.toEqual([]);
  });
});
