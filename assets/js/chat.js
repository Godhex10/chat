/* =============================================================
   Chat — threads, messages, realtime, optimistic send,
   presence, typing indicators, read receipts.
   Phases 3 + 4. Attachments land in Phase 5.
   ============================================================= */

(function () {
  "use strict";

  const PAGE_SIZE = 40;
  const TYPING_PING_EVERY = 1500;  // don't broadcast more often than this
  const TYPING_CLEAR_AFTER = 3000; // hide the indicator if pings stop

  const state = {
    me: null,
    email: null,
    conversations: [],
    activeId: null,
    peer: null,
    peerLastRead: null,     // when the other person last opened this thread
    online: new Set(),
    rendered: new Set(),
    oldestLoaded: null,
    reachedStart: false,
    loadingOlder: false,
    channel: null,          // postgres changes
    presenceChannel: null,  // who's online
    typingChannel: null,    // per-conversation broadcast
    lastTypingPing: 0,
    typingHideTimer: null,
  };

  /* ---------- tiny helpers ------------------------------------ */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  // Message content is user input rendered into an HTML string.
  // Skip this and anyone can inject script tags into every thread
  // they belong to.
  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initials(profile) {
    return (profile.display_name || profile.username || "?").trim().charAt(0).toUpperCase();
  }

  function nameOf(profile) {
    return profile.display_name || profile.username;
  }

  function clockTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function relativeTime(iso) {
    const then = new Date(iso);
    const mins = Math.floor((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return mins + " min";
    if (mins < 1440) return Math.floor(mins / 60) + " hr";
    const days = Math.floor(mins / 1440);
    if (days < 7) return days + "d";
    return then.toLocaleDateString([], { day: "2-digit", month: "short" });
  }

  function dayLabel(iso) {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const sameDay = (a, b) => a.toDateString() === b.toDateString();

    if (sameDay(date, today)) return "Today";
    if (sameDay(date, yesterday)) return "Yesterday";
    return date.toLocaleDateString([], {
      day: "numeric",
      month: "long",
      year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
    });
  }

  function dayKey(iso) {
    return new Date(iso).toDateString();
  }

  /* Simplebar moves your content into an injected wrapper, so
     scrollTop on the original div silently does nothing. */
  function scroller() {
    return $("#chat-scroll .simplebar-content-wrapper") || $("#chat-scroll");
  }

  function scrollToBottom(smooth) {
    const el = scroller();
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  function nearBottom() {
    const el = scroller();
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }

  function avatarMarkup(profile, sizeClass) {
    if (profile.avatar_url) {
      return '<img src="' + esc(profile.avatar_url) + '" class="rounded-circle ' + sizeClass + '" alt="">';
    }
    return (
      '<span class="avatar-title rounded-circle bg-primary-subtle text-primary ' +
      sizeClass + '">' + esc(initials(profile)) + "</span>"
    );
  }

  /* ---------- current user ------------------------------------ */

  async function loadMe() {
    const { data: userData } = await window.sb.auth.getUser();
    if (!userData || !userData.user) {
      window.location.replace("login.html");
      return false;
    }

    state.email = userData.user.email;

    const { data, error } = await window.sb
      .from("profiles")
      .select("id, username, display_name, avatar_url")
      .eq("id", userData.user.id)
      .single();

    if (error || !data) {
      console.error("No profile row for this account.", error);
      alert("Your account has no profile. Sign out and register again.");
      return false;
    }

    state.me = data;
    paintMe();
    return true;
  }

  function paintMe() {
    $$("[data-me-name]").forEach((el) => (el.textContent = nameOf(state.me)));
    $$("[data-me-username]").forEach((el) => (el.textContent = "@" + state.me.username));
    $$("[data-me-email]").forEach((el) => (el.textContent = state.email || "—"));
    if (state.me.avatar_url) {
      $$("[data-me-avatar]").forEach((el) => (el.src = state.me.avatar_url));
    }
    const nameField = $("#profile-display-name");
    if (nameField) nameField.value = state.me.display_name || "";
  }

  /* ---------- conversation list -------------------------------- */

  async function loadConversations() {
    const { data, error } = await window.sb.rpc("list_conversations");
    if (error) {
      console.error("list_conversations failed", error);
      return;
    }
    state.conversations = data || [];
    renderConversations();
  }

  function renderConversations() {
    const list = $("#conversation-list");
    const empty = $("#conversation-empty");
    const filter = ($("#chat-filter").value || "").toLowerCase().trim();

    const rows = state.conversations.filter((row) => {
      if (!filter) return true;
      return (
        (row.other_username || "").toLowerCase().includes(filter) ||
        (row.other_display_name || "").toLowerCase().includes(filter) ||
        (row.last_message_text || "").toLowerCase().includes(filter)
      );
    });

    empty.classList.toggle("d-none", rows.length > 0);
    list.innerHTML = rows.map(conversationItem).join("");
    paintOnlineStrip();
  }

  function conversationItem(row) {
    const peer = {
      username: row.other_username,
      display_name: row.other_display_name,
      avatar_url: row.other_avatar_url,
    };

    let preview;
    if (row.last_message_kind === "image") {
      preview = '<i class="ri-image-fill align-middle me-1 ms-0"></i> Photo';
    } else if (row.last_message_kind === "file") {
      preview = '<i class="ri-file-text-fill align-middle me-1 ms-0"></i> File';
    } else if (row.last_message_text) {
      preview = (row.last_message_sender === state.me.id ? "You: " : "") + esc(row.last_message_text);
    } else {
      preview = "<em>No messages yet</em>";
    }

    const unread = row.unread_count > 0;
    const badge = unread
      ? '<div class="unread-message"><span class="badge badge-soft-danger rounded-pill">' +
        (row.unread_count > 99 ? "99+" : row.unread_count) + "</span></div>"
      : "";

    const isOnline = state.online.has(row.other_id);

    return (
      '<li class="' + (unread ? "unread " : "") +
      (row.conversation_id === state.activeId ? "active" : "") +
      '" data-conversation="' + esc(row.conversation_id) +
      '" data-peer="' + esc(row.other_id) + '">' +
      '<a href="javascript:void(0);">' +
      '<div class="d-flex">' +
      '<div class="chat-user-img ' + (isOnline ? "online" : "away") +
      ' align-self-center me-3 ms-0">' +
      avatarMarkup(peer, "avatar-xs") +
      '<span class="user-status"></span>' +
      "</div>" +
      '<div class="flex-grow-1 overflow-hidden">' +
      '<h5 class="text-truncate font-size-15 mb-1">' + esc(nameOf(peer)) + "</h5>" +
      '<p class="chat-user-message text-truncate mb-0">' + preview + "</p>" +
      "</div>" +
      '<div class="font-size-11">' +
      (row.last_message_text || row.last_message_kind ? relativeTime(row.last_message_at) : "") +
      "</div>" + badge +
      "</div></a></li>"
    );
  }

  /* ---------- presence -----------------------------------------
     Supabase tracks online state on the channel itself and drops
     it automatically when the socket closes. No table, no rows,
     nothing left behind by a crashed tab.
     ------------------------------------------------------------- */

  function startPresence() {
    state.presenceChannel = window.sb.channel("online-users", {
      config: { presence: { key: state.me.id } },
    });

    state.presenceChannel
      .on("presence", { event: "sync" }, () => {
        const raw = state.presenceChannel.presenceState();
        state.online = new Set(Object.keys(raw));
        paintPresence();
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await state.presenceChannel.track({ online_at: new Date().toISOString() });
        }
      });
  }

  function paintPresence() {
    // sidebar dots
    $$("#conversation-list li[data-peer]").forEach((li) => {
      const img = li.querySelector(".chat-user-img");
      if (!img) return;
      const on = state.online.has(li.dataset.peer);
      img.classList.toggle("online", on);
      img.classList.toggle("away", !on);
    });

    // the open thread's header dot
    const dot = $("#peer-online-dot");
    if (dot) {
      dot.classList.toggle("d-none", !(state.peer && state.online.has(state.peer.id)));
    }

    paintOnlineStrip();
  }

  function paintOnlineStrip() {
    const strip = $("#online-strip");
    const wrap = $("#online-strip-wrap");
    if (!strip || !wrap) return;

    const people = state.conversations.filter((row) => state.online.has(row.other_id));

    wrap.classList.toggle("d-none", people.length === 0);

    strip.innerHTML = people
      .map((row) => {
        const peer = {
          username: row.other_username,
          display_name: row.other_display_name,
          avatar_url: row.other_avatar_url,
        };
        return (
          '<a href="javascript:void(0);" class="user-status-box" ' +
          'data-conversation="' + esc(row.conversation_id) + '" ' +
          'data-peer="' + esc(row.other_id) + '">' +
          '<div class="avatar-xs mx-auto d-block chat-user-img online">' +
          avatarMarkup(peer, "avatar-xs") +
          '<span class="user-status"></span>' +
          "</div>" +
          '<h5 class="font-size-13 text-truncate mt-3 mb-1">' +
          esc(nameOf(peer)) + "</h5></a>"
        );
      })
      .join("");
  }

  /* ---------- typing -------------------------------------------
     Broadcast, not database. These are ephemeral pings that live
     only on the websocket — writing them as rows would mean a
     Postgres insert every few keystrokes, replicated to every
     subscriber, for information worthless two seconds later.
     ------------------------------------------------------------- */

  function startTypingChannel(conversationId) {
    if (state.typingChannel) {
      window.sb.removeChannel(state.typingChannel);
      state.typingChannel = null;
    }

    state.typingChannel = window.sb.channel("typing:" + conversationId, {
      config: { broadcast: { self: false } },
    });

    state.typingChannel
      .on("broadcast", { event: "typing" }, (message) => {
        if (!message.payload || message.payload.userId === state.me.id) return;
        showTyping(message.payload.typing !== false);
      })
      .subscribe();
  }

  function pingTyping() {
    if (!state.typingChannel) return;
    const now = Date.now();
    if (now - state.lastTypingPing < TYPING_PING_EVERY) return;
    state.lastTypingPing = now;
    state.typingChannel.send({
      type: "broadcast",
      event: "typing",
      payload: { userId: state.me.id, typing: true },
    });
  }

  function stopTyping() {
    if (!state.typingChannel) return;
    state.lastTypingPing = 0;
    state.typingChannel.send({
      type: "broadcast",
      event: "typing",
      payload: { userId: state.me.id, typing: false },
    });
  }

  function showTyping(isTyping) {
    const label = $("#peer-typing");
    if (!label) return;

    clearTimeout(state.typingHideTimer);

    if (!isTyping) {
      label.classList.add("d-none");
      return;
    }

    label.classList.remove("d-none");
    // if pings stop arriving, assume they walked away mid-sentence
    state.typingHideTimer = setTimeout(() => {
      label.classList.add("d-none");
    }, TYPING_CLEAR_AFTER);
  }

  /* ---------- contacts ----------------------------------------- */

  let contactTimer = null;

  async function loadContacts(term) {
    const { data, error } = await window.sb.rpc("search_users", { term: term || "" });
    const list = $("#contact-list");
    const empty = $("#contact-empty");

    if (error) {
      console.error("search_users failed", error);
      return;
    }

    empty.classList.toggle("d-none", (data || []).length > 0);

    list.innerHTML = (data || [])
      .map(
        (person) =>
          '<li data-start-chat="' + esc(person.id) + '">' +
          '<a href="javascript:void(0);">' +
          '<div class="d-flex align-items-center">' +
          '<div class="chat-user-img ' + (state.online.has(person.id) ? "online" : "away") +
          ' align-self-center me-3 ms-0">' +
          avatarMarkup(person, "avatar-xs") +
          '<span class="user-status"></span>' +
          "</div>" +
          '<div class="flex-grow-1 overflow-hidden">' +
          '<h5 class="text-truncate font-size-14 mb-0">' + esc(nameOf(person)) + "</h5>" +
          '<p class="text-muted text-truncate font-size-13 mb-0">@' + esc(person.username) + "</p>" +
          "</div>" +
          '<i class="ri-chat-new-line text-muted"></i>' +
          "</div></a></li>"
      )
      .join("");
  }

  /* ---------- opening a thread --------------------------------- */

  async function openConversation(conversationId, peerId) {
    state.activeId = conversationId;
    state.rendered.clear();
    state.oldestLoaded = null;
    state.reachedStart = false;
    state.peerLastRead = null;

    $("#message-list").innerHTML = "";
    $("#no-thread").classList.add("d-none");
    $("#message-input").disabled = false;
    $("#send-button").disabled = false;
    showTyping(false);

    document.body.classList.add("user-chat-show");

    const { data: peer } = await window.sb
      .from("profiles")
      .select("id, username, display_name, avatar_url")
      .eq("id", peerId)
      .single();

    state.peer = peer;

    if (peer) {
      $("#peer-name").textContent = nameOf(peer);
      $("#peer-avatar-wrap").innerHTML = avatarMarkup(peer, "avatar-xs");
    }

    await refreshPeerReadStamp();
    highlightActive();
    paintPresence();
    startTypingChannel(conversationId);

    await loadMessages();
    await markRead();
  }

  /* Which of the two read columns belongs to the other person
     depends on the uuid ordering, so read the row and work it out. */
  async function refreshPeerReadStamp(row) {
    let conv = row;

    if (!conv) {
      const { data } = await window.sb
        .from("conversations")
        .select("user_a, user_b, user_a_last_read_at, user_b_last_read_at")
        .eq("id", state.activeId)
        .single();
      conv = data;
    }

    if (!conv) return;

    state.peerLastRead =
      conv.user_a === state.me.id ? conv.user_b_last_read_at : conv.user_a_last_read_at;

    paintTicks();
  }

  function highlightActive() {
    $$("#conversation-list li").forEach((li) => {
      li.classList.toggle("active", li.dataset.conversation === state.activeId);
      if (li.dataset.conversation === state.activeId) {
        li.classList.remove("unread");
        const badge = li.querySelector(".unread-message");
        if (badge) badge.remove();
      }
    });
  }

  async function startChatWith(peerId) {
    const { data, error } = await window.sb.rpc("get_or_create_conversation", {
      other_user: peerId,
    });

    if (error) {
      console.error("get_or_create_conversation failed", error);
      return;
    }

    await loadConversations();

    const chatTab = document.getElementById("pills-chat-tab");
    if (chatTab && window.bootstrap) {
      window.bootstrap.Tab.getOrCreateInstance(chatTab).show();
    }

    await openConversation(data, peerId);
  }

  /* ---------- messages ----------------------------------------- */

  async function loadMessages() {
    const { data, error } = await window.sb
      .from("messages")
      .select("*")
      .eq("conversation_id", state.activeId)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);

    if (error) {
      console.error("loading messages failed", error);
      return;
    }

    const rows = (data || []).slice().reverse();
    if (rows.length < PAGE_SIZE) state.reachedStart = true;
    if (rows.length) state.oldestLoaded = rows[0].created_at;

    renderMessageBatch(rows, "append");
    paintTicks();
    scrollToBottom(false);
  }

  async function loadOlder() {
    if (state.loadingOlder || state.reachedStart || !state.oldestLoaded) return;

    state.loadingOlder = true;
    $("#older-loader").classList.remove("d-none");

    const el = scroller();
    const previousHeight = el ? el.scrollHeight : 0;

    const { data, error } = await window.sb
      .from("messages")
      .select("*")
      .eq("conversation_id", state.activeId)
      .lt("created_at", state.oldestLoaded)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);

    $("#older-loader").classList.add("d-none");
    state.loadingOlder = false;

    if (error) {
      console.error("loading older messages failed", error);
      return;
    }

    const rows = (data || []).slice().reverse();
    if (rows.length < PAGE_SIZE) state.reachedStart = true;
    if (!rows.length) return;

    state.oldestLoaded = rows[0].created_at;
    renderMessageBatch(rows, "prepend");
    paintTicks();

    if (el) el.scrollTop = el.scrollHeight - previousHeight;
  }

  function renderMessageBatch(rows, mode) {
    const list = $("#message-list");
    const parts = [];
    let lastDay = null;

    if (mode === "append") {
      const existing = list.querySelector("li[data-day]:last-of-type");
      lastDay = existing ? existing.dataset.day : null;
    }

    rows.forEach((row) => {
      if (state.rendered.has(row.id)) return;
      state.rendered.add(row.id);

      const key = dayKey(row.created_at);
      if (key !== lastDay) {
        parts.push(
          '<li data-day="' + esc(key) + '"><div class="chat-day-title">' +
          '<span class="title">' + esc(dayLabel(row.created_at)) + "</span></div></li>"
        );
        lastDay = key;
      }

      parts.push(messageMarkup(row));
    });

    if (!parts.length) return;

    if (mode === "prepend") {
      list.insertAdjacentHTML("afterbegin", parts.join(""));
    } else {
      list.insertAdjacentHTML("beforeend", parts.join(""));
    }
  }

  function messageMarkup(row, pending) {
    const mine = row.sender_id === state.me.id;
    const author = mine ? state.me : state.peer || { username: "?" };

    const body = row.content
      ? '<p class="mb-0">' + esc(row.content).replace(/\n/g, "<br>") + "</p>"
      : "";

    const edited = row.edited_at
      ? ' <span class="align-middle font-size-11">(edited)</span>'
      : "";

    // only your own messages carry receipts — you can't "read" your own
    const ticks = mine ? ' <span class="msg-ticks align-middle"></span>' : "";

    const menu = mine
      ? '<div class="dropdown align-self-start">' +
        '<a class="dropdown-toggle" href="#" role="button" data-bs-toggle="dropdown">' +
        '<i class="ri-more-2-fill"></i></a>' +
        '<div class="dropdown-menu">' +
        '<a class="dropdown-item" href="#" data-copy>Copy <i class="ri-file-copy-line float-end text-muted"></i></a>' +
        '<a class="dropdown-item" href="#" data-delete>Delete <i class="ri-delete-bin-line float-end text-muted"></i></a>' +
        "</div></div>"
      : "";

    return (
      '<li class="' + (mine ? "right " : "") + (pending ? "msg-pending" : "") +
      '" data-message="' + esc(row.id) + '"' +
      ' data-day="' + esc(dayKey(row.created_at)) + '"' +
      ' data-at="' + esc(row.created_at) + '"' +
      ' data-mine="' + (mine ? "1" : "0") + '">' +
      '<div class="conversation-list">' +
      '<div class="chat-avatar">' + avatarMarkup(author, "avatar-xs") + "</div>" +
      '<div class="user-chat-content">' +
      '<div class="ctext-wrap">' +
      '<div class="ctext-wrap-content">' +
      body +
      '<p class="chat-time mb-0"><i class="ri-time-line align-middle"></i> ' +
      '<span class="align-middle">' + esc(clockTime(row.created_at)) + "</span>" +
      edited + ticks +
      "</p>" +
      "</div>" + menu +
      "</div>" +
      '<div class="conversation-name">' + esc(nameOf(author)) + "</div>" +
      "</div></div></li>"
    );
  }

  /* ---------- read receipts ------------------------------------
     A message counts as read when it's older than the other
     person's last_read_at. One timestamp per participant does the
     work of an entire per-message receipts table.
     ------------------------------------------------------------- */

  function paintTicks() {
    const readUpTo = state.peerLastRead ? new Date(state.peerLastRead).getTime() : 0;

    $$('#message-list li[data-mine="1"]').forEach((li) => {
      const slot = li.querySelector(".msg-ticks");
      if (!slot) return;

      if (li.classList.contains("msg-pending") || li.classList.contains("msg-failed")) {
        slot.innerHTML = "";
        return;
      }

      const sentAt = new Date(li.dataset.at).getTime();

      slot.innerHTML =
        sentAt <= readUpTo
          ? '<i class="ri-check-double-line text-info"></i>'
          : '<i class="ri-check-line"></i>';
    });
  }

  async function markRead() {
    if (!state.activeId) return;
    await window.sb.rpc("mark_read", { conv_id: state.activeId });
  }

  /* ---------- sending -------------------------------------------
     Optimistic. The browser mints the uuid and uses it as the row's
     primary key, so the realtime echo of our own message arrives
     under an id already on screen and dedupes cleanly.
     ------------------------------------------------------------- */

  async function sendMessage(text) {
    const id = crypto.randomUUID();
    const row = {
      id: id,
      conversation_id: state.activeId,
      sender_id: state.me.id,
      content: text,
      created_at: new Date().toISOString(),
      edited_at: null,
      attachment_kind: null,
    };

    state.rendered.add(id);
    renderPending(row);
    scrollToBottom(true);
    stopTyping();

    const { error } = await window.sb.from("messages").insert({
      id: id,
      conversation_id: state.activeId,
      sender_id: state.me.id,
      content: text,
    });

    const bubble = document.querySelector('[data-message="' + id + '"]');

    if (error) {
      console.error("send failed", error);
      if (bubble) {
        bubble.classList.remove("msg-pending");
        bubble.classList.add("msg-failed");
        const time = bubble.querySelector(".chat-time");
        if (time) {
          time.innerHTML =
            '<span class="text-danger">Not sent — </span>' +
            '<a href="#" class="msg-retry text-danger" data-retry>retry</a>';
        }
        bubble.dataset.retryText = text;
      }
      return;
    }

    if (bubble) bubble.classList.remove("msg-pending");
    paintTicks();
    loadConversations();
  }

  function renderPending(row) {
    const list = $("#message-list");
    const key = dayKey(row.created_at);
    const lastDayEl = list.querySelector("li[data-day]:last-of-type");

    if (!lastDayEl || lastDayEl.dataset.day !== key) {
      list.insertAdjacentHTML(
        "beforeend",
        '<li data-day="' + esc(key) + '"><div class="chat-day-title">' +
        '<span class="title">' + esc(dayLabel(row.created_at)) + "</span></div></li>"
      );
    }

    list.insertAdjacentHTML("beforeend", messageMarkup(row, true));
  }

  /* ---------- realtime -----------------------------------------
     One channel, no conversation filter. RLS already limits the
     stream to threads you belong to, and an unfiltered channel is
     what lets the sidebar react to threads that aren't open.
     ------------------------------------------------------------- */

  function subscribe() {
    if (state.channel) window.sb.removeChannel(state.channel);

    state.channel = window.sb
      .channel("db-stream")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        handleIncoming
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "messages" },
        (payload) => {
          const el = document.querySelector('[data-message="' + payload.old.id + '"]');
          if (el) el.remove();
          state.rendered.delete(payload.old.id);
          loadConversations();
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "conversations" },
        (payload) => {
          // the other person opening the thread bumps their timestamp,
          // which is what turns our ticks blue
          if (payload.new.id === state.activeId) {
            refreshPeerReadStamp(payload.new);
          }
        }
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("realtime channel dropped:", status);
        }
      });
  }

  function handleIncoming(payload) {
    const row = payload.new;

    if (state.rendered.has(row.id)) {
      loadConversations();
      return;
    }

    if (row.conversation_id === state.activeId) {
      const stick = nearBottom();
      renderMessageBatch([row], "append");
      paintTicks();
      showTyping(false);
      if (stick) scrollToBottom(true);
      if (!document.hidden) markRead();
    }

    loadConversations();
  }

  /* ---------- events -------------------------------------------- */

  function wire() {
    $("#conversation-list").addEventListener("click", (event) => {
      const li = event.target.closest("li[data-conversation]");
      if (!li) return;
      openConversation(li.dataset.conversation, li.dataset.peer);
    });

    $("#online-strip").addEventListener("click", (event) => {
      const box = event.target.closest("[data-conversation]");
      if (!box) return;
      openConversation(box.dataset.conversation, box.dataset.peer);
    });

    $("#contact-list").addEventListener("click", (event) => {
      const li = event.target.closest("li[data-start-chat]");
      if (!li) return;
      startChatWith(li.dataset.startChat);
    });

    $("#chat-filter").addEventListener("input", renderConversations);

    $("#contact-search").addEventListener("input", (event) => {
      clearTimeout(contactTimer);
      const term = event.target.value;
      contactTimer = setTimeout(() => loadContacts(term), 300);
    });

    const contactsTab = document.getElementById("pills-contacts-tab");
    if (contactsTab) {
      contactsTab.addEventListener("shown.bs.tab", () => loadContacts(""));
    }

    // typing pings
    $("#message-input").addEventListener("input", (event) => {
      if (!state.activeId) return;
      if (event.target.value.trim()) {
        pingTyping();
      } else {
        stopTyping();
      }
    });

    $("#send-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const field = $("#message-input");
      const text = field.value.trim();
      if (!text || !state.activeId) return;
      field.value = "";
      sendMessage(text);
    });

    $("#message-list").addEventListener("click", async (event) => {
      const retry = event.target.closest("[data-retry]");
      if (retry) {
        event.preventDefault();
        const li = retry.closest("li[data-message]");
        const text = li.dataset.retryText;
        state.rendered.delete(li.dataset.message);
        li.remove();
        sendMessage(text);
        return;
      }

      const copy = event.target.closest("[data-copy]");
      if (copy) {
        event.preventDefault();
        const li = copy.closest("li[data-message]");
        const p = li.querySelector(".ctext-wrap-content p");
        if (p) navigator.clipboard.writeText(p.textContent);
        return;
      }

      const del = event.target.closest("[data-delete]");
      if (del) {
        event.preventDefault();
        const li = del.closest("li[data-message]");
        const id = li.dataset.message;
        li.remove();
        state.rendered.delete(id);
        await window.sb.from("messages").delete().eq("id", id);
        loadConversations();
      }
    });

    const el = scroller();
    if (el) {
      el.addEventListener("scroll", () => {
        if (el.scrollTop < 80) loadOlder();
      });
    }

    $("#scroll-latest").addEventListener("click", (event) => {
      event.preventDefault();
      scrollToBottom(true);
    });

    $$(".user-chat-remove").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.body.classList.remove("user-chat-show");
      })
    );

    // coming back to the tab counts as reading
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.activeId) markRead();
    });

    $("#profile-save").addEventListener("click", async () => {
      const value = $("#profile-display-name").value.trim();
      const feedback = $("#profile-feedback");

      const { error } = await window.sb
        .from("profiles")
        .update({ display_name: value || null })
        .eq("id", state.me.id);

      if (error) {
        feedback.textContent = "Couldn't save. Try again.";
        feedback.className = "form-text text-danger mt-2";
        return;
      }

      state.me.display_name = value || null;
      paintMe();
      loadConversations();
      feedback.textContent = "Saved.";
      feedback.className = "form-text text-success mt-2";
      setTimeout(() => (feedback.textContent = ""), 2500);
    });

    ["#logout-desktop", "#logout-mobile"].forEach((sel) => {
      const link = $(sel);
      if (!link) return;
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        if (state.presenceChannel) await window.sb.removeChannel(state.presenceChannel);
        if (state.typingChannel) await window.sb.removeChannel(state.typingChannel);
        if (state.channel) await window.sb.removeChannel(state.channel);
        await window.sb.auth.signOut();
        window.location.replace("login.html");
      });
    });

    setInterval(renderConversations, 60000);
  }

  /* ---------- boot ---------------------------------------------- */

  document.addEventListener("DOMContentLoaded", async function () {
    const ready = await loadMe();
    if (!ready) return;

    wire();
    await loadConversations();
    subscribe();
    startPresence();
  });
})();
