/* =============================================================
   Auth — login, register, password reset, route guard.
   Vanilla JS. jQuery is loaded by the template but not used here.
   ============================================================= */

(function () {
  "use strict";

  /* ---------- alert helper ------------------------------------ */

  function alertBox() {
    return document.getElementById("auth-alert");
  }

  function showAlert(message, kind) {
    const box = alertBox();
    if (!box) return;
    box.textContent = message;
    box.className = "alert alert-" + (kind || "danger") + " mb-3";
  }

  function clearAlert() {
    const box = alertBox();
    if (!box) return;
    box.textContent = "";
    box.className = "alert d-none";
  }

  /* ---------- button busy state -------------------------------- */

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.idleLabel = button.innerHTML;
      button.disabled = true;
      button.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>' +
        busyLabel;
    } else {
      button.disabled = false;
      if (button.dataset.idleLabel) button.innerHTML = button.dataset.idleLabel;
    }
  }

  /* ---------- translate Supabase errors into plain English ----- */

  function readableError(error) {
    const raw = (error && error.message ? error.message : "").toLowerCase();

    if (raw.includes("invalid login credentials"))
      return "That email and password don't match an account.";
    if (raw.includes("email not confirmed"))
      return "Confirm your email address first. Check your inbox for the link.";
    if (raw.includes("user already registered") || raw.includes("already been registered"))
      return "An account already uses this email. Sign in instead.";
    if (raw.includes("password should be at least"))
      return "Passwords need at least 6 characters.";
    if (raw.includes("unable to validate email") || raw.includes("invalid email"))
      return "Check the email address — that format isn't valid.";
    if (raw.includes("rate limit") || raw.includes("too many"))
      return "Too many attempts. Wait a minute and try again.";
    if (raw.includes("failed to fetch") || raw.includes("networkerror"))
      return "Can't reach the server. Check your connection.";

    return error && error.message ? error.message : "Something went wrong. Try again.";
  }

  /* ---------- route guard --------------------------------------
     Pages tag themselves with data-auth on <body>:
       data-auth="guest"   → signed-in users get sent to the app
       data-auth="require" → signed-out users get sent to login
     ------------------------------------------------------------- */

  async function guard() {
    const mode = document.body.getAttribute("data-auth");
    if (!mode) return;

    const { data } = await window.sb.auth.getSession();
    const signedIn = Boolean(data.session);

    if (mode === "guest" && signedIn) {
      window.location.replace("index.html");
    } else if (mode === "require" && !signedIn) {
      window.location.replace("login.html");
    }
  }

  /* ---------- login -------------------------------------------- */

  function wireLogin() {
    const form = document.getElementById("login-form");
    if (!form) return;

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      clearAlert();

      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;
      const remember = document.getElementById("remember-check").checked;
      const button = document.getElementById("login-submit");

      if (!email || !password) {
        showAlert("Enter your email and password.");
        return;
      }

      // set the storage preference before the session is written
      localStorage.setItem(window.REMEMBER_FLAG, remember ? "true" : "false");

      setBusy(button, true, "Signing in");

      const { error } = await window.sb.auth.signInWithPassword({ email, password });

      if (error) {
        setBusy(button, false);
        showAlert(readableError(error));
        return;
      }

      window.location.replace("index.html");
    });
  }

  /* ---------- forgot password ---------------------------------- */

  function wireForgotPassword() {
    const link = document.getElementById("forgot-password");
    if (!link) return;

    link.addEventListener("click", async function (event) {
      event.preventDefault();
      clearAlert();

      const field = document.getElementById("login-email");
      const email = field ? field.value.trim() : "";

      if (!email) {
        showAlert("Type your email above first, then tap this link.", "warning");
        if (field) field.focus();
        return;
      }

      const { error } = await window.sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/reset-password.html",
      });

      if (error) {
        showAlert(readableError(error));
        return;
      }

      showAlert("Reset link sent. Check your inbox.", "success");
    });
  }

  /* ---------- register ----------------------------------------- */

  function wireRegister() {
    const form = document.getElementById("register-form");
    if (!form) return;

    const usernameField = document.getElementById("register-username");
    const usernameHint = document.getElementById("username-hint");
    let checkTimer = null;
    let usernameOk = false;

    /* live availability check, debounced so we aren't hitting the
       database on every keystroke */
    if (usernameField) {
      usernameField.addEventListener("input", function () {
        const value = usernameField.value.trim();
        usernameOk = false;
        clearTimeout(checkTimer);

        if (!value) {
          usernameHint.textContent = "";
          usernameHint.className = "form-text";
          return;
        }

        if (!/^[a-zA-Z0-9_]{3,20}$/.test(value)) {
          usernameHint.textContent =
            "3–20 characters. Letters, numbers and underscores only.";
          usernameHint.className = "form-text text-danger";
          return;
        }

        usernameHint.textContent = "Checking…";
        usernameHint.className = "form-text text-muted";

        checkTimer = setTimeout(async function () {
          const { data, error } = await window.sb.rpc("username_available", {
            candidate: value,
          });

          if (error) {
            usernameHint.textContent = "";
            usernameHint.className = "form-text";
            return;
          }

          if (data) {
            usernameOk = true;
            usernameHint.textContent = value + " is free.";
            usernameHint.className = "form-text text-success";
          } else {
            usernameHint.textContent = value + " is taken. Pick another.";
            usernameHint.className = "form-text text-danger";
          }
        }, 400);
      });
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      clearAlert();

      const email = document.getElementById("register-email").value.trim();
      const username = usernameField.value.trim();
      const password = document.getElementById("register-password").value;
      const button = document.getElementById("register-submit");

      if (!email || !username || !password) {
        showAlert("Fill in every field to continue.");
        return;
      }

      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        showAlert("Usernames are 3–20 characters: letters, numbers and underscores.");
        usernameField.focus();
        return;
      }

      if (password.length < 6) {
        showAlert("Passwords need at least 6 characters.");
        return;
      }

      if (!usernameOk) {
        // the debounce may not have finished — check once, synchronously
        const { data } = await window.sb.rpc("username_available", {
          candidate: username,
        });
        if (!data) {
          showAlert(username + " is taken. Pick another username.");
          usernameField.focus();
          return;
        }
      }

      // new accounts stay signed in on this device
      localStorage.setItem(window.REMEMBER_FLAG, "true");

      setBusy(button, true, "Creating account");

      const { data, error } = await window.sb.auth.signUp({
        email: email,
        password: password,
        options: { data: { username: username, display_name: username } },
      });

      if (error) {
        setBusy(button, false);
        showAlert(readableError(error));
        return;
      }

      /* No session on the response means email confirmation is
         switched on in the dashboard and the user has to click a
         link before they can sign in. */
      if (!data.session) {
        setBusy(button, false);
        form.reset();
        if (usernameHint) usernameHint.textContent = "";
        showAlert(
          "Account created. Click the link in your email to activate it.",
          "success"
        );
        return;
      }

      window.location.replace("index.html");
    });
  }

  /* ---------- boot --------------------------------------------- */

  document.addEventListener("DOMContentLoaded", function () {
    guard();
    wireLogin();
    wireForgotPassword();
    wireRegister();
  });
})();
