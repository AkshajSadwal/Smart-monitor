import type {Collector} from '../../packages/collection-core/collector';
import {simulatedPage,simulatedLookup} from '../../fixtures/simulated';
import type {Store} from './storage';

export function simulatedCollector(store:Store):Collector {
  return {
    id:'mock',
    capabilities:['Seeded polling','Engagement rechecks','Local personalization'],
    async collect(_lists,now,signal,commit) {
      signal.throwIfAborted();
      const page=simulatedPage(store.value('cursor:mock',0),now,store.value('run:mock',0));
      commit(page.posts,false,'cursor:mock',page.cursor);
      return true;
    },
    async lookup(posts,now,signal,attempts) {
      signal.throwIfAborted();
      return {posts:posts.map(post=>simulatedLookup(post,attempts?.get(post.id)??1,now)),removed:[]};
    },
  };
}
