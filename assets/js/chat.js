/* =============================================================
   Chat — thread list, message pane, realtime, optimistic send.
   Phase 3. Presence, typing and uploads land in Phase 4 and 5.
   ============================================================= */

(function () {
  "use strict";

  const PAGE_SIZE = 40;

  const state = {
    me: null,            // profiles row
    email: null,
    conversations: [],   // list_conversations() rows
    activeId: null,      // conversation uuid
    peer: null,          // profile of the other person
    rendered: new Set(), // message ids already in the DOM
    oldestLoaded: null,  // created_at of the topmost message
    reachedStart: false,
    loadingOlder: false,
    channel: null,
  };

  /* ---------- tiny helpers ------------------------------------ */

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  // Message content is user input rendered into an HTML string.
  // Skip this and any user can inject script tags into every thread
  // they are part of.
  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initials(profile) {
    const source = (profile.display_name || profile.username || "?").trim();
    return source.charAt(0).toUpperCase();
  }

  function nameOf(profile) {
    return profile.display_name || profile.username;
  }

  function clockTime(iso) {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
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

  /* Simplebar hijacks the scroll container, so element.scrollTop on
     the original div does nothing. The real scroller is the wrapper
     simplebar injects. */
  function scroller() {
    const wrap = $("#chat-scroll .simplebar-content-wrapper");
    return wrap || $("#chat-scroll");
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
      return (
        '<img src="' + esc(profile.avatar_url) + '" class="rounded-circle ' +
        sizeClass + '" alt="">'
      );
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
      // signed in but no profile row — the signup trigger failed
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
      const mine = row.last_message_sender === state.me.id;
      preview = (mine ? "You: " : "") + esc(row.last_message_text);
    } else {
      preview = "<em>No messages yet</em>";
    }

    const unread = row.unread_count > 0;
    const badge = unread
      ? '<div class="unread-message"><span class="badge badge-soft-danger rounded-pill">' +
        (row.unread_count > 99 ? "99+" : row.unread_count) +
        "</span></div>"
      : "";

    return (
      '<li class="' +
      (unread ? "unread " : "") +
      (row.conversation_id === state.activeId ? "active" : "") +
      '" data-conversation="' + esc(row.conversation_id) +
      '" data-peer="' + esc(row.other_id) + '">' +
      '<a href="javascript:void(0);">' +
      '<div class="d-flex">' +
      '<div class="chat-user-img align-self-center me-3 ms-0">' +
      avatarMarkup(peer, "avatar-xs") +
      '<span class="user-status"></span>' +
      "</div>" +
      '<div class="flex-grow-1 overflow-hidden">' +
      '<h5 class="text-truncate font-size-15 mb-1">' + esc(nameOf(peer)) + "</h5>" +
      '<p class="chat-user-message text-truncate mb-0">' + preview + "</p>" +
      "</div>" +
      '<div class="font-size-11">' +
      (row.last_message_text || row.last_message_kind ? relativeTime(row.last_message_at) : "") +
      "</div>" +
      badge +
      "</div></a></li>"
    );
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
          '<div class="chat-user-img align-self-center me-3 ms-0">' +
          avatarMarkup(person, "avatar-xs") +
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

    $("#message-list").innerHTML = "";
    $("#no-thread").classList.add("d-none");
    $("#message-input").disabled = false;
    $("#send-button").disabled = false;

    // mobile: the template reveals the pane with this class
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

    highlightActive();
    await loadMessages();
    await markRead();
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

    // jump the sidebar back to Chats
    const chatTab = document.getElementById("pills-chat-tab");
    if (chatTab && window.bootstrap) {
      window.bootstrap.Tab.getOrCreateInstance(chatTab).show();
    }

    await openConversation(data, peerId);
  }

  /* ---------- messages ----------------------------------------- */

  async function loadMessages() {
    let query = window.sb
      .from("messages")
      .select("*")
      .eq("conversation_id", state.activeId)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE);

    const { data, error } = await query;

    if (error) {
      console.error("loading messages failed", error);
      return;
    }

    const rows = (data || []).slice().reverse();

    if (rows.length < PAGE_SIZE) state.reachedStart = true;
    if (rows.length) state.oldestLoaded = rows[0].created_at;

    renderMessageBatch(rows, "append");
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

    // keep the reading position steady instead of jumping to the top
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
      '" data-message="' + esc(row.id) + '" data-day="' + esc(dayKey(row.created_at)) + '">' +
      '<div class="conversation-list">' +
      '<div class="chat-avatar">' + avatarMarkup(author, "avatar-xs") + "</div>" +
      '<div class="user-chat-content">' +
      '<div class="ctext-wrap">' +
      '<div class="ctext-wrap-content">' +
      body +
      '<p class="chat-time mb-0"><i class="ri-time-line align-middle"></i> ' +
      '<span class="align-middle">' + esc(clockTime(row.created_at)) + "</span>" +
      edited +
      "</p>" +
      "</div>" +
      menu +
      "</div>" +
      '<div class="conversation-name">' + esc(nameOf(author)) + "</div>" +
      "</div></div></li>"
    );
  }

  /* ---------- sending ------------------------------------------
     Optimistic. The bubble appears immediately with a client-made
     uuid, which is also the row's primary key. That shared id is
     what makes the realtime echo of our own message deduplicate
     cleanly instead of rendering twice.
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

  /* ---------- read receipts (write side) ------------------------ */

  async function markRead() {
    if (!state.activeId) return;
    await window.sb.rpc("mark_read", { conv_id: state.activeId });
  }

  /* ---------- realtime -----------------------------------------
     One channel, no conversation filter. RLS already limits the
     stream to threads you belong to, and an unfiltered channel is
     what lets the sidebar update for threads that aren't open.
     ------------------------------------------------------------- */

  function subscribe() {
    if (state.channel) window.sb.removeChannel(state.channel);

    state.channel = window.sb
      .channel("messages-stream")
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
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("realtime channel dropped:", status);
        }
      });
  }

  function handleIncoming(payload) {
    const row = payload.new;

    // our own optimistic bubble is already on screen under this id
    if (state.rendered.has(row.id)) {
      loadConversations();
      return;
    }

    if (row.conversation_id === state.activeId) {
      const stick = nearBottom();
      renderMessageBatch([row], "append");
      if (stick) scrollToBottom(true);
      markRead();
    }

    loadConversations();
  }

  /* ---------- events -------------------------------------------- */

  function wire() {
    // pick a thread
    $("#conversation-list").addEventListener("click", (event) => {
      const li = event.target.closest("li[data-conversation]");
      if (!li) return;
      openConversation(li.dataset.conversation, li.dataset.peer);
    });

    // start a thread from contacts
    $("#contact-list").addEventListener("click", (event) => {
      const li = event.target.closest("li[data-start-chat]");
      if (!li) return;
      startChatWith(li.dataset.startChat);
    });

    // filter threads
    $("#chat-filter").addEventListener("input", renderConversations);

    // search people, debounced
    $("#contact-search").addEventListener("input", (event) => {
      clearTimeout(contactTimer);
      const term = event.target.value;
      contactTimer = setTimeout(() => loadContacts(term), 300);
    });

    // load contacts the first time the tab is opened
    const contactsTab = document.getElementById("pills-contacts-tab");
    if (contactsTab) {
      contactsTab.addEventListener("shown.bs.tab", () => loadContacts(""));
    }

    // send
    $("#send-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const field = $("#message-input");
      const text = field.value.trim();
      if (!text || !state.activeId) return;
      field.value = "";
      sendMessage(text);
    });

    // message actions
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
        const text = li.querySelector(".ctext-wrap-content p").textContent;
        navigator.clipboard.writeText(text);
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

    // infinite scroll upward
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

    // mobile back button
    $$(".user-chat-remove").forEach((btn) =>
      btn.addEventListener("click", () => {
        document.body.classList.remove("user-chat-show");
      })
    );

    // profile save
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

    // logout
    ["#logout-desktop", "#logout-mobile"].forEach((sel) => {
      const link = $(sel);
      if (!link) return;
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        if (state.channel) await window.sb.removeChannel(state.channel);
        await window.sb.auth.signOut();
        window.location.replace("login.html");
      });
    });

    // refresh timestamps in the sidebar so "5 min" doesn't go stale
    setInterval(renderConversations, 60000);
  }

  /* ---------- boot ---------------------------------------------- */

  document.addEventListener("DOMContentLoaded", async function () {
    const ready = await loadMe();
    if (!ready) return;

    wire();
    await loadConversations();
    subscribe();
  });
})();
