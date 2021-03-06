var { Value, Set, Struct, computed } = require('mutant')
var pull = require('pull-stream')
var ref = require('ssb-ref')
var set = require('lodash/set')
var unset = require('lodash/unset')
var get = require('lodash/get')
var isEmpty = require('lodash/isEmpty')

var tagsCache = {}
var messagesCache = {}
var cacheLoading = false
var sync = Value(false)

function Tag (server) {
  return (tagId, nameFn) => {
    let tagName

    if (nameFn) {
      // Use nameFn is supplied
      tagName = nameFn(tagId)
    } else if (server.names) {
      // Fallback to ssb-names plugin if available
      tagName = Value()
      server.names.getSignifier(tagId, function (signifier) {
        tagName.set(signifier)
      })
    } else {
      // Otherwise use short id
      tagName = Value(tagId.slice(1, 10))
    }

    return Struct({
      tagId,
      tagName
    })
  }
}

function messageTags (server) {
  return (msgId) => {
    if (!ref.isLink(msgId)) throw new Error('Requires an ssb ref!')
    return withSync(computed(getObs(msgId, server, messagesCache), getMessageTags))
  }
}

function messageTagsFrom (server) {
  return (msgId, author) => {
    if (!ref.isLink(msgId) || !ref.isFeedId(author)) throw new Error('Requires an ssb ref!')
    return withSync(computed([getObs(msgId, server, messagesCache), author], getMessageTagsFrom))
  }
}

function messageTaggers (server) {
  return (msgId, tagId) => {
    if (!ref.isLink(msgId) || !ref.isLink(tagId)) throw new Error('Requires an ssb ref!')
    return withSync(computed([getObs(msgId, server, messagesCache), tagId], getMessageTaggers))
  }
}

function allTags (server) {
  return () => withSync(getAllTags(getCache(server, tagsCache)))
}

function allTagsFrom (server) {
  return (author) => {
    if (!ref.isFeedId(author)) throw new Error('Requires an ssb ref!')
    return withSync(computed(getObs(author, server, tagsCache), getAllTagsFrom))
  }
}

function messagesTaggedByWith (server) {
  return (author, tagId) => {
    if (!ref.isFeedId(author) || !ref.isLink(tagId)) throw new Error('Requires an ssb ref!')
    return withSync(computed([getObs(author, server, tagsCache), tagId], getTaggedMessages))
  }
}

function withSync (obs) {
  obs.sync = sync
  return obs
}

function getObs (id, server, lookup) {
  if (!ref.isLink(id)) throw new Error('Requires an ssb ref!')
  if (!cacheLoading) {
    cacheLoading = true
    loadCache(server)
  }
  if (!lookup[id]) {
    lookup[id] = Value({})
  }
  return lookup[id]
}

function getCache (server, lookup) {
  if (!cacheLoading) {
    cacheLoading = true
    loadCache(server)
  }
  return lookup
}

function update (id, values, server, lookup) {
  const state = getObs(id, server, lookup)
  const lastState = state()
  var changed = false

  for (const tag in values) {
    const lastTag = lastState[tag]
    const isUnusedTag = isEmpty(values[tag]) && (lastTag === undefined || !isEmpty(lastTag))
    if (isUnusedTag) {
      set(lastState, [ tag ], {})
      changed = true
      continue
    }
    for (const key in values[tag]) {
      const value = get(values, [ tag, key ])
      const lastValue = get(lastState, [ tag, key ])
      if (value !== lastValue) {
        if (value) {
          set(lastState, [ tag, key ], value)
        } else {
          unset(lastState, [ tag, key ])
        }
        changed = true
      }
    }
  }

  if (changed) {
    state.set(lastState)
  }
}

// TODO: rewrite with a flume index to improve performance
function loadCache (server) {
  pull(
    server.tags.stream({ live: true }),
    pull.drain(item => {
      if (!sync()) {
        // populate tags observable cache
        const messageLookup = {}
        for (const author in item) {
          update(author, item[author], server, tagsCache)

          // generate message lookup
          for (const tag in item[author]) {
            for (const message in item[author][tag]) {
              set(messageLookup, [message, tag, author], item[author][tag][message])
            }
          }
        }

        // populate messages observable cache
        for (const message in messageLookup) {
          update(message, messageLookup[message], server, messagesCache)
        }

        if (!sync()) {
          sync.set(true)
        }
      } else if (item && ref.isLink(item.tagKey) && ref.isFeedId(item.author) && ref.isLink(item.message)) {
        // handle realtime updates
        const { tagKey, author, message, tagged, timestamp } = item
        if (tagged) {
          update(author, { [tagKey]: { [message]: timestamp } }, server, tagsCache)
          update(message, { [tagKey]: { [author]: timestamp } }, server, messagesCache)
        } else {
          update(author, { [tagKey]: { [message]: false } }, server, tagsCache)
          update(message, { [tagKey]: { [author]: false } }, server, messagesCache)
        }
      }
    })
  )
}

function getTaggedMessages (lookup, key) {
  const messages = []
  for (const msg in lookup[key]) {
    if (lookup[key][msg]) {
      messages.push(msg)
    }
  }
  return messages
}

function getMessageTags (lookup) {
  const tags = []
  for (const tag in lookup) {
    if (!isEmpty(lookup[tag])) {
      tags.push(tag)
    }
  }
  return tags
}

function getMessageTagsFrom (lookup, author) {
  const tags = []
  for (const tag in lookup) {
    if (lookup[tag][author]) {
      tags.push(tag)
    }
  }
  return tags
}

function getMessageTaggers (lookup, key) {
  const taggers = []
  for (const author in lookup[key]) {
    if (lookup[key][author]) {
      taggers.push(author)
    }
  }
  return taggers
}

function getAllTags (lookup) {
  const tags = Set([])
  for (const author in lookup) {
    const authorTags = lookup[author]()
    for (const tag in authorTags) {
      tags.add(tag)
    }
  }
  return tags
}

function getAllTagsFrom (lookup) {
  const tags = []
  for (const tag in lookup) {
    if (isEmpty(lookup[tag])) continue
    tags.push(tag)
  }
  return tags
}

module.exports = {
  Tag,
  messageTags,
  messageTagsFrom,
  messageTaggers,
  allTags,
  allTagsFrom,
  messagesTaggedByWith
}
