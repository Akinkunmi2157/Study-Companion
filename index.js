(() => {
    "use strict";

    // 1. Initialize Supabase Connection
    const SUPABASE_URL = "https://bbcrrugbulytupozsfpr.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_xNEdsuqY4FR42LoPekTn6A_Z2Nrm8iJ";

    const createClient = window.supabase?.createClient || window.supabaseClient?.createClient || window.supabase;
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    window.__debugSupabase = supabase;
    // Supabase Storage bucket that holds every student's uploaded resource files.
    // Objects are stored under `${userId}/${resourceId}-${fileName}` so each
    // student can only see their own folder when Storage RLS is scoped by auth.uid().
    const RESOURCE_BUCKET = "study-resources";
    // Table that holds each student's tasks, sessions, resources metadata,
    // profile, and settings — synced across every device a student signs into.
    const STATE_TABLE = "user_state";

    // Track active Object URL to prevent memory leaks
    let currentBlobUrl = null;

    // Dynamic Storage Key generator tied to the authenticated user ID
    function getStorageKey(userId) {
        return userId ? `digital_study_companion_state_${userId}` : "digital_study_companion_state_guest";
    }

    // Helper to get current logged-in user
    async function getCurrentUser() {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            return user;
        } catch (err) {
            console.error("Auth check failed:", err);
            return null;
        }
    }

    // -------------------------------------------------------------
    // GEMINI SUPABASE EDGE FUNCTION INTEGRATION
    // -------------------------------------------------------------
    const AI_TIMEOUT_MS = 45000;

    function extractAiText(data) {
        if (!data) return "";
        if (typeof data === "string") return data.trim();

        const direct = data.text || data.answer || data.response || data.output;
        if (typeof direct === "string") return direct.trim();

        const candidateText = data?.candidates?.[0]?.content?.parts
            ?.map(part => part?.text || "")
            .join("")
            .trim();

        return candidateText || "";
    }

    async function invokeGeminiOnce(promptText, extra = {}) {
        const invokePromise = supabase.functions.invoke("gemini-chat", {
            body: { prompt: promptText, ...extra }
        });

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("AI request timed out. Please try again.")), AI_TIMEOUT_MS);
        });

        return Promise.race([invokePromise, timeoutPromise]);
    }

    async function askGemini(promptText, extra = {}) {
        const prompt = String(promptText || "").trim();
        if (!prompt) throw new Error("The AI request was empty.");

        try {
            let { data, error } = await invokeGeminiOnce(prompt, extra);

            if (error) {
                const status = Number(error?.context?.status || error?.status || 0);
                if (status === 401 || status === 403) {
                    await supabase.auth.refreshSession();
                    ({ data, error } = await invokeGeminiOnce(prompt, extra));
                }
            }

            if (error) {
                let detail = "";
                try {
                    const context = error.context;
                    if (context && typeof context.json === "function") {
                        const body = await context.json();
                        detail = body?.error || body?.message || "";
                    }
                } catch (_) {
                    // Ignore body parsing failure and use the generic message.
                }

                console.error("Gemini Edge Function Error:", error);
                throw new Error(detail || error.message || "The AI service could not be reached.");
            }

            // Surface an error the function itself reported in a 200 response
            if (data && typeof data === "object" && data.error) {
                console.error("Gemini Edge Function returned an error payload:", data.error);
                throw new Error(typeof data.error === "string" ? data.error : "The AI service reported an error.");
            }

            const text = extractAiText(data);
            if (!text) {
                console.error("Unexpected Gemini response:", data);
                throw new Error("The AI service returned an empty response.");
            }

            return text;
        } catch (err) {
            console.error("Failed to invoke Gemini Edge Function:", err);
            throw err instanceof Error ? err : new Error("Error connecting to the AI service.");
        }
    } 
    const defaultState = {
        tasks: [],
        sessions: [],
        resources: [],
        profile: { name: "", email: "", school: "", course: "", bio: "", photo: "" },
        settings: {
            focusMinutes: 25,
            shortBreakMinutes: 5,
            longBreakMinutes: 15,
            cyclesBeforeLongBreak: 4,
            weeklyGoalMinutes: 300,
            focusTracking: true,
            verificationChecks: true,
            sound: true,
            theme: "light"
        }
    };
    let currentUser = null;
    let pendingSignup = null; // { email, name } while awaiting OTP confirmation
    let pendingRecoveryEmail = null; // Email awaiting password-recovery OTP verification
    let state = structuredClone(defaultState);
    const timer = {
        mode: "focus",
        totalSeconds: state.settings.focusMinutes * 60,
        remainingSeconds: state.settings.focusMinutes * 60,
        running: false,
        intervalId: null,
        cycle: 1,
        sessionStartedAt: null,
        focusViolations: 0,
        checksPassed: 0,
        checksFailed: 0,
        verificationTimeoutId: null,
        verificationIntervalId: null,
        nextVerificationAt: null,
        pendingCompletion: null,
        automaticallyPausedByBlur: false,
        reflectionResourceKeywords: null,
        pendingAssessment: null,
        activeResourceId: null
    };

    // In-memory AI tutor chat session. Not persisted — a fresh chat starts
    // each time a resource is opened for tutoring, keyed to that resource's
    // extracted study text so answers stay grounded in what the student is
    // actually reading.
    const tutorChat = {
        resourceId: null,
        resourceTitle: "",
        context: "",
        history: [], // [{ role: "user" | "assistant", text }]
        sending: false
    };

    const els = {
        authShell: document.getElementById("authShell"),
        appShell: document.getElementById("appShell"),
        loginForm: document.getElementById("loginForm"), loginEmail: document.getElementById("loginEmail"), loginPassword: document.getElementById("loginPassword"), loginError: document.getElementById("loginError"), rememberMe: document.getElementById("rememberMe"),
        signupForm: document.getElementById("signupForm"), signupName: document.getElementById("signupName"), signupEmail: document.getElementById("signupEmail"), signupPassword: document.getElementById("signupPassword"), signupConfirmPassword: document.getElementById("signupConfirmPassword"), signupError: document.getElementById("signupError"), acceptTerms: document.getElementById("acceptTerms"), passwordStrengthBar: document.getElementById("passwordStrengthBar"), passwordHint: document.getElementById("passwordHint"),
        verifyEmailForm: document.getElementById("verifyEmailForm"), verifyEmailCode: document.getElementById("verifyEmailCode"), verifyEmailError: document.getElementById("verifyEmailError"), verifyEmailAddress: document.getElementById("verifyEmailAddress"), resendVerificationCode: document.getElementById("resendVerificationCode"),
        forgotForm: document.getElementById("forgotForm"), forgotEmail: document.getElementById("forgotEmail"), forgotError: document.getElementById("forgotError"), resetForm: document.getElementById("resetForm"), resetCode: document.getElementById("resetCode"), resetPassword: document.getElementById("resetPassword"), resetConfirmPassword: document.getElementById("resetConfirmPassword"), resetError: document.getElementById("resetError"), resetInstruction: document.getElementById("resetInstruction"), demoResetCode: document.getElementById("demoResetCode"),
        logoutButton: document.getElementById("logoutButton"),
        navItems: document.querySelectorAll(".nav-item"),
        pageSections: document.querySelectorAll(".page-section"),
        pageTitle: document.getElementById("pageTitle"),
        todayLabel: document.getElementById("todayLabel"),
        sidebar: document.getElementById("sidebar"),
        menuButton: document.getElementById("menuButton"),
        themeToggle: document.getElementById("themeToggle"),
        profileShortcut: document.getElementById("profileShortcut"),

        openResourceModal: document.getElementById("openResourceModal"),
        resourceModal: document.getElementById("resourceModal"),
        resourceForm: document.getElementById("resourceForm"),
        resourceTitle: document.getElementById("resourceTitle"),
        resourceKind: document.getElementById("resourceKind"),
        resourceFile: document.getElementById("resourceFile"),
        resourceFileDrop: document.getElementById("resourceFileDrop"),
        resourceFileIcon: document.getElementById("resourceFileIcon"),
        resourceFileLabel: document.getElementById("resourceFileLabel"),
        resourceFileName: document.getElementById("resourceFileName"),
        resourceFileClear: document.getElementById("resourceFileClear"),
        resourceUrl: document.getElementById("resourceUrl"),
        resourceNotes: document.getElementById("resourceNotes"),
        resourceFileGroup: document.getElementById("resourceFileGroup"),
        resourceUrlGroup: document.getElementById("resourceUrlGroup"),
        resourceSubmitButton: document.getElementById("resourceSubmitButton"),
        resourceGrid: document.getElementById("resourceGrid"),
        resourceSearch: document.getElementById("resourceSearch"),
        resourceTypeFilter: document.getElementById("resourceTypeFilter"),
        documentCount: document.getElementById("documentCount"),
        videoCount: document.getElementById("videoCount"),
        linkCount: document.getElementById("linkCount"),
        studyWorkspace: document.getElementById("studyWorkspace"),
        workspaceTitle: document.getElementById("workspaceTitle"),
        workspaceViewer: document.getElementById("workspaceViewer"),
        closeWorkspace: document.getElementById("closeWorkspace"),
        toggleWorkspaceFullscreen: document.getElementById("toggleWorkspaceFullscreen"),
        openTutorChat: document.getElementById("openTutorChat"),
        tutorChatModal: document.getElementById("tutorChatModal"),
        tutorChatTitle: document.getElementById("tutorChatTitle"),
        tutorChatResourceNote: document.getElementById("tutorChatResourceNote"),
        tutorChatMessages: document.getElementById("tutorChatMessages"),
        tutorChatForm: document.getElementById("tutorChatForm"),
        tutorChatInput: document.getElementById("tutorChatInput"),
        tutorChatSend: document.getElementById("tutorChatSend"),
        clearTutorChat: document.getElementById("clearTutorChat"),

        dashboardStreak: document.getElementById("dashboardStreak"),
        dashboardHours: document.getElementById("dashboardHours"),
        dashboardTasks: document.getElementById("dashboardTasks"),
        dashboardSessions: document.getElementById("dashboardSessions"),
        dashboardTaskList: document.getElementById("dashboardTaskList"),
        weeklyChart: document.getElementById("weeklyChart"),

        timerDisplay: document.getElementById("timerDisplay"),
        timerRing: document.getElementById("timerRing"),
        timerModeLabel: document.getElementById("timerModeLabel"),
        timerStatus: document.getElementById("timerStatus"),
        startPauseTimer: document.getElementById("startPauseTimer"),
        resetTimer: document.getElementById("resetTimer"),
        skipTimer: document.getElementById("skipTimer"),
        modeTabs: document.querySelectorAll(".mode-tab"),
        sessionCycle: document.getElementById("sessionCycle"),
        focusViolationCount: document.getElementById("focusViolationCount"),
        checksPassedCount: document.getElementById("checksPassedCount"),
        sessionTask: document.getElementById("sessionTask"),
        sessionGoal: document.getElementById("sessionGoal"),
        goalCount: document.getElementById("goalCount"),

        openTaskModal: document.getElementById("openTaskModal"),
        taskModal: document.getElementById("taskModal"),
        taskForm: document.getElementById("taskForm"),
        taskModalTitle: document.getElementById("taskModalTitle"),
        editingTaskId: document.getElementById("editingTaskId"),
        taskTitle: document.getElementById("taskTitle"),
        taskDescription: document.getElementById("taskDescription"),
        taskPriority: document.getElementById("taskPriority"),
        taskDueDate: document.getElementById("taskDueDate"),
        taskStatus: document.getElementById("taskStatus"),
        taskResource: document.getElementById("taskResource"),
        taskSearch: document.getElementById("taskSearch"),
        priorityFilter: document.getElementById("priorityFilter"),
        todoList: document.getElementById("todoList"),
        inProgressList: document.getElementById("inProgressList"),
        doneList: document.getElementById("doneList"),
        todoCount: document.getElementById("todoCount"),
        inProgressCount: document.getElementById("inProgressCount"),
        doneCount: document.getElementById("doneCount"),

        progressStreak: document.getElementById("progressStreak"),
        longestStreak: document.getElementById("longestStreak"),
        progressTotalTime: document.getElementById("progressTotalTime"),
        completionRate: document.getElementById("completionRate"),
        progressChart: document.getElementById("progressChart"),
        goalRing: document.getElementById("goalRing"),
        weeklyGoalPercent: document.getElementById("weeklyGoalPercent"),
        weeklyGoalCaption: document.getElementById("weeklyGoalCaption"),
        historyBody: document.getElementById("historyBody"),
        clearHistory: document.getElementById("clearHistory"),

        focusMinutesSetting: document.getElementById("focusMinutesSetting"),
        shortBreakSetting: document.getElementById("shortBreakSetting"),
        longBreakSetting: document.getElementById("longBreakSetting"),
        cyclesSetting: document.getElementById("cyclesSetting"),
        weeklyGoalSetting: document.getElementById("weeklyGoalSetting"),
        focusTrackingSetting: document.getElementById("focusTrackingSetting"),
        verificationSetting: document.getElementById("verificationSetting"),
        soundSetting: document.getElementById("soundSetting"),
        saveSettings: document.getElementById("saveSettings"),
        resetAllData: document.getElementById("resetAllData"),

        profileForm: document.getElementById("profileForm"),
        profileName: document.getElementById("profileName"),
        profileEmail: document.getElementById("profileEmail"),
        profileSchool: document.getElementById("profileSchool"),
        profileCourse: document.getElementById("profileCourse"),
        profileBio: document.getElementById("profileBio"),
        profileAvatarLarge: document.getElementById("profileAvatarLarge"),
        profileDisplayName: document.getElementById("profileDisplayName"),
        profileDisplayMeta: document.getElementById("profileDisplayMeta"),
        profileResourceCount: document.getElementById("profileResourceCount"),
        profileTaskCount: document.getElementById("profileTaskCount"),
        profileSessionCount: document.getElementById("profileSessionCount"),
        profilePhotoInput: document.getElementById("profilePhotoInput"),
        profilePhotoButton: document.getElementById("profilePhotoButton"),
        changeProfilePhoto: document.getElementById("changeProfilePhoto"),
        removeProfilePhoto: document.getElementById("removeProfilePhoto"),

        verificationModal: document.getElementById("verificationModal"),
        verificationCountdown: document.getElementById("verificationCountdown"),
        confirmPresence: document.getElementById("confirmPresence"),

        reflectionModal: document.getElementById("reflectionModal"),
        reflectionText: document.getElementById("reflectionText"),
        reflectionCount: document.getElementById("reflectionCount"),
        reflectionValidation: document.getElementById("reflectionValidation"),
        reflectionResourceNote: document.getElementById("reflectionResourceNote"),
        reflectionAlignment: document.getElementById("reflectionAlignment"),
        saveReflection: document.getElementById("saveReflection"),
        discardSession: document.getElementById("discardSession"),

        reflectionViewModal: document.getElementById("reflectionViewModal"),
        reflectionViewTitle: document.getElementById("reflectionViewTitle"),
        reflectionViewText: document.getElementById("reflectionViewText"),

        assessmentModal: document.getElementById("assessmentModal"),
        assessmentForm: document.getElementById("assessmentForm"),
        assessmentSummaryStatus: document.getElementById("assessmentSummaryStatus"),
        objectiveQuestions: document.getElementById("objectiveQuestions"),
        theoryQuestions: document.getElementById("theoryQuestions"),
        assessmentValidation: document.getElementById("assessmentValidation"),
        backToReflection: document.getElementById("backToReflection"),

        toastContainer: document.getElementById("toastContainer")
    };

    // -------------------------------------------------------------
    // SUPABASE AUTHENTICATION HELPERS
    // -------------------------------------------------------------

    function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
    function passwordScore(password) {
        if (!password) return 0;
        return [password.length >= 8, /[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
    }
    function validPassword(password) { return password.length >= 8 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password); }

    function showAuthView(id) {
        document.querySelectorAll(".auth-view").forEach(view => view.classList.toggle("active", view.id === id));
        document.querySelectorAll(".form-error").forEach(error => { error.textContent = ""; });
    }

    async function handleSignup(event) {
        event.preventDefault();
        const name = els.signupName.value.trim();
        const email = els.signupEmail.value.trim().toLowerCase();
        const password = els.signupPassword.value;
        const confirm = els.signupConfirmPassword.value;

        if (name.length < 2) return els.signupError.textContent = "Please enter your full name.";
        if (!validEmail(email)) return els.signupError.textContent = "Enter a valid email address.";
        if (!validPassword(password)) return els.signupError.textContent = "Use at least 8 characters with uppercase, lowercase, and a number.";
        if (password !== confirm) return els.signupError.textContent = "The passwords do not match.";
        if (!els.acceptTerms.checked) return els.signupError.textContent = "Please accept the Terms and Privacy Notice.";

        const { data, error } = await supabase.auth.signUp({
            email: email,
            password: password,
            options: { data: { full_name: name } }
        });

        if (error) {
            els.signupError.textContent = error.message;
            return;
        }

        if (data.session) {
            await supabase.auth.signOut();
        }

        pendingSignup = { email, name };
        els.verifyEmailAddress.textContent = email;
        els.verifyEmailError.textContent = "";
        els.verifyEmailForm.reset();
        showAuthView("verifyEmailView");
        showToast("Enter the 6-digit code we emailed you to finish creating your account.", "warning");
    }

    // UPDATED SUPABASE OTP VERIFICATION HANDLER
    async function handleVerifySignupOtp(event) {
        event.preventDefault();
        if (!pendingSignup) {
            els.verifyEmailError.textContent = "Start the signup again to request a new code.";
            return;
        }

        const code = els.verifyEmailCode.value.trim();
        if (!/^\d{6}$/.test(code)) {
            els.verifyEmailError.textContent = "Enter the 6-digit code from your email.";
            return;
        }

        // Send 6-digit OTP code to Supabase backend to verify
        const { data, error } = await supabase.auth.verifyOtp({
            email: pendingSignup.email,
            token: code,
            type: "email"
        });

        if (error) {
            els.verifyEmailError.textContent = error.message || "That code is invalid or expired. Request a new one below.";
            return;
        }

        const name = pendingSignup.name;
        pendingSignup = null;
        showToast("Email verified — account created successfully!");
        await launchApp(data.user, name);
    }

    async function handleResendVerificationCode() {
        if (!pendingSignup) {
            els.verifyEmailError.textContent = "Start the signup again to request a new code.";
            return;
        }

        const { error } = await supabase.auth.resend({
            type: "signup",
            email: pendingSignup.email
        });

        if (error) {
            els.verifyEmailError.textContent = error.message;
        } else {
            els.verifyEmailError.textContent = "";
            showToast("A new code is on its way to your email.");
        }
    }

    async function handleLogin(event) {
        event.preventDefault();
        const email = els.loginEmail.value.trim().toLowerCase();
        const password = els.loginPassword.value;

        if (!validEmail(email)) {
            els.loginError.textContent = "Enter a valid email address.";
            return;
        }

        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            els.loginError.textContent = "Incorrect email or password. Please try again.";
        } else {
            showToast("Welcome back!");
            await launchApp(data.user);
        }
    }

    async function handleForgot(event) {
        event.preventDefault();
        const email = els.forgotEmail.value.trim().toLowerCase();

        if (!validEmail(email)) {
            els.forgotError.textContent = "Enter a valid email address.";
            return;
        }

        els.forgotError.textContent = "";

        const { error } = await supabase.auth.resetPasswordForEmail(email);

        if (error) {
            els.forgotError.textContent = error.message;
            return;
        }

        pendingRecoveryEmail = email;

        els.resetInstruction.textContent =
            `Enter the 6-digit code sent to ${email}, then choose a new password.`;

        if (els.demoResetCode) {
            els.demoResetCode.textContent = "";
            els.demoResetCode.classList.add("hidden");
        }

        els.resetForm.reset();
        showAuthView("resetView");

        showToast("A password reset code has been sent to your email.");
    }
    async function handleReset(event) {
        event.preventDefault();

        if (!pendingRecoveryEmail) {
            els.resetError.textContent =
                "Request a new password reset code first.";
            return;
        }

        const code = els.resetCode.value.trim();
        const password = els.resetPassword.value;
        const confirm = els.resetConfirmPassword.value;

        if (!/^\d{6}$/.test(code)) {
            els.resetError.textContent =
                "Enter the 6-digit code sent to your email.";
            return;
        }

        if (!validPassword(password)) {
            els.resetError.textContent =
                "Use at least 8 characters with uppercase, lowercase, and a number.";
            return;
        }

        if (password !== confirm) {
            els.resetError.textContent = "The passwords do not match.";
            return;
        }

        els.resetError.textContent = "";

        const { error: verificationError } =
            await supabase.auth.verifyOtp({
                email: pendingRecoveryEmail,
                token: code,
                type: "recovery"
            });

        if (verificationError) {
            els.resetError.textContent =
                verificationError.message ||
                "The reset code is invalid or has expired.";
            return;
        }

        const { error: updateError } =
            await supabase.auth.updateUser({
                password: password
            });

        if (updateError) {
            els.resetError.textContent = updateError.message;
            return;
        }

        pendingRecoveryEmail = null;
        els.resetForm.reset();

        await supabase.auth.signOut();

        showToast("Password updated successfully!");
        showAuthView("resetSuccessView");
    }

    async function logout() {
        if (timer.running && !window.confirm("A focus session is running. Log out anyway?")) return;

        revokeBlobUrl();
        await flushSaveState();
        await supabase.auth.signOut();
        currentUser = null;
        state = structuredClone(defaultState);
        els.appShell.classList.add("hidden");
        els.authShell.classList.remove("hidden");
        showAuthView("loginView");
        showToast("Logged out.", "warning");
    }

    function initialiseAuth() {
        document.querySelectorAll("[data-auth-view]").forEach(button => button.addEventListener("click", () => showAuthView(button.dataset.authView)));
        document.querySelectorAll("[data-password-toggle]").forEach(button => button.addEventListener("click", () => {
            const input = document.getElementById(button.dataset.passwordToggle);
            input.type = input.type === "password" ? "text" : "password";
            button.textContent = input.type === "password" ? "Show" : "Hide";
        }));
        els.signupPassword.addEventListener("input", () => {
            const val = els.signupPassword.value;
            if (!val) {
                els.passwordStrengthBar.style.width = "0%";
                els.passwordHint.textContent = "";
                return;
            }
            const score = passwordScore(val);
            els.passwordStrengthBar.style.width = `${score * 20}%`;
            els.passwordHint.textContent = score <= 2 ? "Weak password" : score <= 4 ? "Good password" : "Strong password";
        });
        els.loginForm.addEventListener("submit", handleLogin);
        els.signupForm.addEventListener("submit", handleSignup);
        if (els.verifyEmailForm) els.verifyEmailForm.addEventListener("submit", handleVerifySignupOtp);
        if (els.resendVerificationCode) els.resendVerificationCode.addEventListener("click", handleResendVerificationCode);
        if (els.forgotForm) els.forgotForm.addEventListener("submit", handleForgot);
        if (els.resetForm) els.resetForm.addEventListener("submit", handleReset);
    }

    // -------------------------------------------------------------
    // CLOUD STATE SYNC (Supabase `user_state` table)
    //
    // Tasks, sessions, resource metadata, profile, and settings all
    // live in one JSONB row per user in `user_state`, keyed by
    // user_id. localStorage is kept ONLY as an instant-load cache for
    // the current browser; the source of truth is always Supabase, so
    // signing in from any browser/device pulls the same data.
    // -------------------------------------------------------------

    function mergeWithDefaults(stored) {
        if (!stored) return structuredClone(defaultState);
        return {
            tasks: Array.isArray(stored.tasks) ? stored.tasks : [],
            sessions: Array.isArray(stored.sessions) ? stored.sessions : [],
            resources: Array.isArray(stored.resources) ? stored.resources : [],
            profile: { ...defaultState.profile, ...(stored.profile || {}) },
            settings: {
                ...defaultState.settings,
                ...(stored.settings || {}),
                focusTracking: true,
                verificationChecks: true,
                sound: true
            }
        };
    }

    function readLocalCache(userId) {
        try {
            const stored = JSON.parse(localStorage.getItem(getStorageKey(userId)));
            return stored ? mergeWithDefaults(stored) : null;
        } catch (error) {
            console.warn("Could not read local cache.", error);
            return null;
        }
    }

    function writeLocalCache(userId, value) {
        try {
            localStorage.setItem(getStorageKey(userId), JSON.stringify(value));
        } catch (error) {
            console.warn("Could not write local cache.", error);
        }
    }

    async function loadState(userId) {
        try {
            const { data, error } = await supabase
                .from(STATE_TABLE)
                .select("data")
                .eq("user_id", userId)
                .maybeSingle();

            if (error) throw error;

            if (data && data.data) {
                const merged = mergeWithDefaults(data.data);
                writeLocalCache(userId, merged);
                return merged;
            }

            // No cloud row yet for this user (first login on this account).
            // Seed the cloud with whatever is cached locally, if anything,
            // so we don't silently drop pre-existing local data.
            const cached = readLocalCache(userId);
            return cached || structuredClone(defaultState);
        } catch (error) {
            console.warn("Could not load state from the cloud — using local cache instead.", error);
            showToast("Could not reach the cloud. Showing your last saved data on this device.", "warning");
            return readLocalCache(userId) || structuredClone(defaultState);
        }
    }

    let saveStateTimeoutId = null;
    let saveStateInFlight = false;
    let saveStateQueuedAgain = false;

    async function persistStateNow() {
        if (!currentUser) return;
        if (saveStateInFlight) {
            saveStateQueuedAgain = true;
            return;
        }
        saveStateInFlight = true;
        try {
            const { error } = await supabase
                .from(STATE_TABLE)
                .upsert(
                    { user_id: currentUser.id, data: state, updated_at: new Date().toISOString() },
                    { onConflict: "user_id" }
                );
            if (error) {
                console.error("Could not save state to the cloud.", error);
                showToast("Could not sync your latest changes to the cloud. They're saved on this device for now.", "error");
            }
        } catch (error) {
            console.error("Could not save state to the cloud.", error);
            showToast("Could not sync your latest changes to the cloud. They're saved on this device for now.", "error");
        } finally {
            saveStateInFlight = false;
            if (saveStateQueuedAgain) {
                saveStateQueuedAgain = false;
                persistStateNow();
            }
        }
    }

    function saveState() {
        if (!currentUser) return;
        // Instant local cache so the current tab/browser reloads fast and
        // still works if the network drops mid-session.
        writeLocalCache(currentUser.id, state);
        // Debounce the cloud write so rapid successive actions (e.g. a
        // sequence of task edits) collapse into one network call.
        if (saveStateTimeoutId) clearTimeout(saveStateTimeoutId);
        saveStateTimeoutId = setTimeout(persistStateNow, 500);
    }

    async function flushSaveState() {
        if (saveStateTimeoutId) {
            clearTimeout(saveStateTimeoutId);
            saveStateTimeoutId = null;
        }
        await persistStateNow();
    }

    function escapeHtml(value = "") {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    // Strips common Markdown syntax Gemini sometimes adds (bold, italics,
    // headers, bullet markers, inline code) so AI replies render as clean
    // plain text instead of showing raw ** and # characters in the chat
    // bubble. Only applied to assistant messages — the student's own
    // typed messages are left untouched.
    function stripMarkdown(text = "") {
        return String(text)
            .replace(/\*\*(.*?)\*\*/g, "$1")   // **bold**
            .replace(/\*(.*?)\*/g, "$1")       // *italic*
            .replace(/^#{1,6}\s+/gm, "")       // # headers
            .replace(/^[-*]\s+/gm, "• ")       // - bullets -> •
            .replace(/`([^`]+)`/g, "$1");      // `inline code`
    }

    function showToast(message, type = "success") {
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.textContent = message;
        els.toastContainer.appendChild(toast);
        setTimeout(() => toast.remove(), 3600);
    }

    function openModal(modal) {
        modal.classList.remove("hidden");
        document.body.style.overflow = "hidden";
    }

    function closeModal(modal) {
        modal.classList.add("hidden");
        if (!document.querySelector(".modal-backdrop:not(.hidden)")) {
            document.body.style.overflow = "";
        }
    }

    function navigate(section) {
        const titleMap = {
            dashboard: "Dashboard",
            library: "Study Library",
            timer: "Study Timer",
            tasks: "Task Board",
            progress: "Progress",
            profile: "Student Profile",
            settings: "Settings"
        };

        els.navItems.forEach(item => {
            item.classList.toggle("active", item.dataset.section === section);
        });

        els.pageSections.forEach(page => {
            page.classList.toggle("active", page.id === `${section}Section`);
        });

        els.pageTitle.textContent = titleMap[section];
        els.sidebar.classList.remove("open");

        if (section === "progress") renderProgress();
        if (section === "tasks") renderTasks();
        if (section === "library") renderResources();
        if (section === "profile") renderProfile();
        if (section === "dashboard") renderDashboard();
    }

    function applyTheme() {
        document.body.classList.toggle("dark", state.settings.theme === "dark");
        els.themeToggle.textContent = state.settings.theme === "dark" ? "☀" : "☾";
    }

    function formatMinutes(totalMinutes) {
        const minutes = Math.max(0, Math.round(totalMinutes));
        const hours = Math.floor(minutes / 60);
        const remainder = minutes % 60;
        return `${hours}h ${remainder}m`;
    }

    function formatDate(dateStringOrTimestamp) {
        const date = new Date(dateStringOrTimestamp);
        if (Number.isNaN(date.getTime())) return "No date";
        return new Intl.DateTimeFormat("en-NG", {
            day: "numeric",
            month: "short",
            year: "numeric"
        }).format(date);
    }

    function getDateKey(date = new Date()) {
        const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return [
            local.getFullYear(),
            String(local.getMonth() + 1).padStart(2, "0"),
            String(local.getDate()).padStart(2, "0")
        ].join("-");
    }

    function getLastSevenDays() {
        const result = [];
        for (let i = 6; i >= 0; i -= 1) {
            const date = new Date();
            date.setHours(0, 0, 0, 0);
            date.setDate(date.getDate() - i);
            result.push(date);
        }
        return result;
    }

    function calculateStreaks() {
        const uniqueDays = [...new Set(state.sessions.map(session => getDateKey(new Date(session.completedAt))))].sort();
        if (!uniqueDays.length) return { current: 0, longest: 0 };

        let longest = 1;
        let running = 1;

        for (let i = 1; i < uniqueDays.length; i += 1) {
            const previous = new Date(`${uniqueDays[i - 1]}T00:00:00`);
            const current = new Date(`${uniqueDays[i]}T00:00:00`);
            const diffDays = Math.round((current - previous) / 86400000);

            if (diffDays === 1) {
                running += 1;
                longest = Math.max(longest, running);
            } else {
                running = 1;
            }
        }

        const latest = new Date(`${uniqueDays.at(-1)}T00:00:00`);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);

        let current = 0;
        if (latest.getTime() === today.getTime() || latest.getTime() === yesterday.getTime()) {
            current = 1;
            for (let i = uniqueDays.length - 1; i > 0; i -= 1) {
                const newer = new Date(`${uniqueDays[i]}T00:00:00`);
                const older = new Date(`${uniqueDays[i - 1]}T00:00:00`);
                if (Math.round((newer - older) / 86400000) === 1) current += 1;
                else break;
            }
        }

        return { current, longest };
    }

    function getWeeklyMinutes() {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const day = start.getDay();
        const distanceFromMonday = day === 0 ? 6 : day - 1;
        start.setDate(start.getDate() - distanceFromMonday);

        return state.sessions
            .filter(session => new Date(session.completedAt) >= start)
            .reduce((sum, session) => sum + session.durationMinutes, 0);
    }

    function renderBarChart(container, days, large = false) {
        const data = days.map(day => {
            const key = getDateKey(day);
            const minutes = state.sessions
                .filter(session => getDateKey(new Date(session.completedAt)) === key)
                .reduce((sum, session) => sum + session.durationMinutes, 0);
            return { day, minutes };
        });

        const max = Math.max(...data.map(item => item.minutes), 30);
        const maxHeight = large ? 230 : 150;

        container.innerHTML = data.map(item => {
            const height = item.minutes === 0 ? 6 : Math.max(12, (item.minutes / max) * maxHeight);
            const label = new Intl.DateTimeFormat("en-NG", { weekday: "short" }).format(item.day);
            return `
        <div class="chart-bar-group" title="${item.minutes} study minutes">
          <span class="chart-value">${item.minutes}m</span>
          <div class="chart-bar" style="height:${height}px"></div>
          <span class="chart-label">${label}</span>
        </div>
      `;
        }).join("");
    }

    function renderDashboard() {
        const totalMinutes = state.sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
        const completedTasks = state.tasks.filter(task => task.status === "done").length;
        const streaks = calculateStreaks();

        els.dashboardStreak.textContent = streaks.current;
        els.dashboardHours.textContent = formatMinutes(totalMinutes);
        els.dashboardTasks.textContent = completedTasks;
        els.dashboardSessions.textContent = state.sessions.length;

        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const activeTasks = state.tasks
            .filter(task => task.status !== "done")
            .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
            .slice(0, 5);

        els.dashboardTaskList.innerHTML = activeTasks.length
            ? activeTasks.map(task => `
        <div class="compact-task">
          <span class="compact-task__status" style="background:${task.priority === "high" ? "var(--danger)" :
                    task.priority === "medium" ? "var(--warning)" : "var(--success)"
                }"></span>
          <div class="compact-task__content">
            <strong>${escapeHtml(task.title)}</strong>
            <small>${task.dueDate ? `Due ${formatDate(task.dueDate)}` : "No due date"}</small>
          </div>
          <span class="priority-badge priority-${task.priority}">${task.priority}</span>
        </div>
      `).join("")
            : `<div class="empty-state">No active tasks. Add a task and give your next session a clear target.</div>`;

        renderBarChart(els.weeklyChart, getLastSevenDays());
    }

    function renderSessionTaskOptions() {
        const currentValue = els.sessionTask.value;
        const options = state.tasks
            .filter(task => task.status !== "done")
            .map(task => `<option value="${task.id}">${escapeHtml(task.title)}</option>`)
            .join("");

        els.sessionTask.innerHTML = `<option value="">General study session</option>${options}`;
        if ([...els.sessionTask.options].some(option => option.value === currentValue)) {
            els.sessionTask.value = currentValue;
        }
    }

    function renderTasks() {
        const query = els.taskSearch.value.trim().toLowerCase();
        const priority = els.priorityFilter.value;

        const filtered = state.tasks.filter(task => {
            const matchesQuery =
                !query ||
                task.title.toLowerCase().includes(query) ||
                task.description.toLowerCase().includes(query);
            const matchesPriority = priority === "all" || task.priority === priority;
            return matchesQuery && matchesPriority;
        });

        const groups = {
            todo: filtered.filter(task => task.status === "todo"),
            inProgress: filtered.filter(task => task.status === "inProgress"),
            done: filtered.filter(task => task.status === "done")
        };

        els.todoCount.textContent = state.tasks.filter(task => task.status === "todo").length;
        els.inProgressCount.textContent = state.tasks.filter(task => task.status === "inProgress").length;
        els.doneCount.textContent = state.tasks.filter(task => task.status === "done").length;

        renderTaskColumn(els.todoList, groups.todo, "todo");
        renderTaskColumn(els.inProgressList, groups.inProgress, "inProgress");
        renderTaskColumn(els.doneList, groups.done, "done");
        renderSessionTaskOptions();
    }

    function renderTaskColumn(container, tasks, status) {
        if (!tasks.length) {
            container.innerHTML = `<div class="empty-state">No tasks here.</div>`;
            return;
        }

        const statusAction = {
            todo: { next: "inProgress", label: "Start" },
            inProgress: { next: "done", label: "Complete" },
            done: { next: "todo", label: "Reopen" }
        }[status];

        container.innerHTML = tasks
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(task => `
        <article class="task-card">
          <div class="task-card__top">
            <span class="priority-badge priority-${task.priority}">${task.priority}</span>
            <button class="task-menu-button" data-edit-task="${task.id}" title="Edit task">✎</button>
          </div>
          <h4>${escapeHtml(task.title)}</h4>
          <p>${escapeHtml(task.description || "No description added.")}</p>
          ${task.resourceId ? `<div class="linked-resource">📎 ${escapeHtml(getResource(task.resourceId)?.title || "Linked resource")}</div>` : ""}
          <div class="task-card__footer">
            <span>${task.dueDate ? `Due ${formatDate(task.dueDate)}` : "No due date"}</span>
            <div class="task-card__actions">
              ${task.resourceId && status !== "done" ? `<button class="task-action-button" data-study-task="${task.id}">Study</button>` : ""}
              <button class="task-action-button" data-move-task="${task.id}" data-next-status="${statusAction.next}">
                ${statusAction.label}
              </button>
              <button class="task-action-button" data-delete-task="${task.id}">Delete</button>
            </div>
          </div>
        </article>
      `).join("");
    }

    function openTaskEditor(task = null) {
        els.taskForm.reset();
        els.editingTaskId.value = task?.id || "";
        els.taskModalTitle.textContent = task ? "Edit task" : "Add a new task";
        els.taskTitle.value = task?.title || "";
        els.taskDescription.value = task?.description || "";
        els.taskPriority.value = task?.priority || "medium";
        els.taskDueDate.value = task?.dueDate || "";
        populateTaskResources();
        els.taskStatus.value = task?.status || "todo";
        els.taskResource.value = task?.resourceId || "";
        openModal(els.taskModal);
        setTimeout(() => els.taskTitle.focus(), 100);
    }

    function saveTask(event) {
        event.preventDefault();
        const id = els.editingTaskId.value;
        const taskData = {
            title: els.taskTitle.value.trim(),
            description: els.taskDescription.value.trim(),
            priority: els.taskPriority.value,
            dueDate: els.taskDueDate.value,
            status: els.taskStatus.value,
            resourceId: els.taskResource.value
        };

        if (!taskData.title) {
            showToast("Please enter a task title.", "error");
            return;
        }

        if (id) {
            const task = state.tasks.find(item => item.id === id);
            if (task) Object.assign(task, taskData);
            showToast("Task updated.");
        } else {
            state.tasks.push({
                id: crypto.randomUUID(),
                ...taskData,
                createdAt: Date.now()
            });
            showToast("Task added.");
        }

        saveState();
        closeModal(els.taskModal);
        renderTasks();
        renderDashboard();
    }

    function deleteTask(id) {
        const task = state.tasks.find(item => item.id === id);
        if (!task) return;
        if (!window.confirm(`Delete "${task.title}"?`)) return;

        state.tasks = state.tasks.filter(item => item.id !== id);
        saveState();
        renderTasks();
        renderDashboard();
        showToast("Task deleted.", "warning");
    }

    function moveTask(id, nextStatus) {
        const task = state.tasks.find(item => item.id === id);
        if (!task) return;
        task.status = nextStatus;
        saveState();
        renderTasks();
        renderDashboard();
        renderProgress();
        showToast(nextStatus === "done" ? "Task completed." : "Task status updated.");
    }

    function getModeMinutes(mode) {
        if (mode === "shortBreak") return state.settings.shortBreakMinutes;
        if (mode === "longBreak") return state.settings.longBreakMinutes;
        return state.settings.focusMinutes;
    }

    function getModeLabel(mode) {
        if (mode === "shortBreak") return "Short break";
        if (mode === "longBreak") return "Long break";
        return "Focus session";
    }

    function setTimerMode(mode, force = false) {
        if (timer.running && !force) {
            showToast("Pause or reset the active timer before changing modes.", "warning");
            return;
        }

        clearTimerIntervals();
        timer.mode = mode;
        timer.totalSeconds = getModeMinutes(mode) * 60;
        timer.remainingSeconds = timer.totalSeconds;
        timer.running = false;
        timer.sessionStartedAt = null;
        timer.focusViolations = 0;
        timer.checksPassed = 0;
        timer.checksFailed = 0;
        timer.nextVerificationAt = null;

        els.modeTabs.forEach(tab => tab.classList.toggle("active", tab.dataset.mode === mode));
        updateTimerUI();
    }

    function updateTimerUI() {
        const minutes = Math.floor(timer.remainingSeconds / 60);
        const seconds = timer.remainingSeconds % 60;
        els.timerDisplay.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

        const elapsed = timer.totalSeconds - timer.remainingSeconds;
        const progress = timer.totalSeconds ? (elapsed / timer.totalSeconds) * 360 : 0;
        els.timerRing.style.setProperty("--progress", `${progress}deg`);

        els.timerModeLabel.textContent = getModeLabel(timer.mode);
        els.timerStatus.textContent = timer.running ? "In progress" : timer.remainingSeconds < timer.totalSeconds ? "Paused" : "Ready";
        els.startPauseTimer.textContent = timer.running ? "Pause" : timer.remainingSeconds < timer.totalSeconds ? "Resume" : "Start";
        els.sessionCycle.textContent = `${timer.cycle} of ${state.settings.cyclesBeforeLongBreak}`;
        els.focusViolationCount.textContent = timer.focusViolations;
        els.checksPassedCount.textContent = timer.checksPassed;
        document.title = timer.running
            ? `${els.timerDisplay.textContent} • ${getModeLabel(timer.mode)}`
            : "Digital Study Companion";
    }

    function toggleTimer() {
        if (timer.running) {
            pauseTimer("Paused");
            return;
        }
        startTimer();
    }

    function startTimer() {
        if (timer.mode === "focus" && timer.remainingSeconds === timer.totalSeconds) {
            timer.sessionStartedAt = Date.now();
            timer.focusViolations = 0;
            timer.checksPassed = 0;
            timer.checksFailed = 0;
            scheduleNextVerification();
        }

        if (timer.mode === "focus" && state.settings.focusTracking && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => { });
        }

        timer.running = true;
        timer.automaticallyPausedByBlur = false;
        timer.intervalId = window.setInterval(tickTimer, 1000);
        updateTimerUI();
    }

    function pauseTimer(status = "Paused") {
        timer.running = false;
        if (timer.intervalId) window.clearInterval(timer.intervalId);
        timer.intervalId = null;
        els.timerStatus.textContent = status;
        updateTimerUI();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
    }

    function resetTimer() {
        clearTimerIntervals();
        timer.running = false;
        timer.remainingSeconds = timer.totalSeconds;
        timer.sessionStartedAt = null;
        timer.focusViolations = 0;
        timer.checksPassed = 0;
        timer.checksFailed = 0;
        timer.nextVerificationAt = null;
        closeModal(els.verificationModal);
        updateTimerUI();
        showToast("Timer reset.", "warning");
    }

    function skipTimer() {
        if (timer.mode === "focus" && timer.remainingSeconds < timer.totalSeconds) {
            if (!window.confirm("Skip this focus session? Its progress will not be logged.")) return;
        }
        completeTimer(true);
    }

    function tickTimer() {
        timer.remainingSeconds -= 1;

        if (
            timer.mode === "focus" &&
            state.settings.verificationChecks &&
            timer.nextVerificationAt &&
            Date.now() >= timer.nextVerificationAt &&
            els.verificationModal.classList.contains("hidden")
        ) {
            showVerificationCheck();
        }

        if (timer.remainingSeconds <= 0) {
            timer.remainingSeconds = 0;
            completeTimer(false);
        }

        updateTimerUI();
    }

    function clearTimerIntervals() {
        if (timer.intervalId) window.clearInterval(timer.intervalId);
        if (timer.verificationTimeoutId) window.clearTimeout(timer.verificationTimeoutId);
        if (timer.verificationIntervalId) window.clearInterval(timer.verificationIntervalId);
        timer.intervalId = null;
        timer.verificationTimeoutId = null;
        timer.verificationIntervalId = null;
    }

    function completeTimer(skipped) {
        clearTimerIntervals();
        timer.running = false;
        closeModal(els.verificationModal);
        playTone(660);

        if (timer.mode === "focus" && !skipped) {
            timer.pendingCompletion = {
                durationMinutes: Math.max(1, Math.round(timer.totalSeconds / 60)),
                completedAt: Date.now(),
                taskId: els.sessionTask.value || null,
                resourceId: timer.activeResourceId || null,
                goal: els.sessionGoal.value.trim(),
                focusViolations: timer.focusViolations,
                checksPassed: timer.checksPassed,
                checksFailed: timer.checksFailed
            };
            prepareReflectionModal();
            openModal(els.reflectionModal);
            return;
        }

        if (timer.mode === "focus") {
            const nextMode =
                timer.cycle >= state.settings.cyclesBeforeLongBreak ? "longBreak" : "shortBreak";
            if (timer.cycle >= state.settings.cyclesBeforeLongBreak) timer.cycle = 1;
            else timer.cycle += 1;
            setTimerMode(nextMode, true);
        } else {
            setTimerMode("focus", true);
        }

        showToast(skipped ? "Timer skipped." : "Break complete.");
    }

    function scheduleNextVerification() {
        if (!state.settings.verificationChecks || timer.mode !== "focus") {
            timer.nextVerificationAt = null;
            return;
        }

        const totalMs = timer.totalSeconds * 1000;
        const minimum = Math.min(8 * 60 * 1000, totalMs * 0.35);
        const maximum = Math.min(18 * 60 * 1000, totalMs * 0.75);

        if (maximum <= 30000 || maximum <= minimum) {
            timer.nextVerificationAt = Date.now() + Math.max(15000, totalMs * 0.5);
            return;
        }

        timer.nextVerificationAt = Date.now() + minimum + Math.random() * (maximum - minimum);
    }

    function showVerificationCheck() {
        if (!timer.running || timer.mode !== "focus") return;

        pauseTimer("Presence check");
        playTone(880);
        openModal(els.verificationModal);

        let seconds = 15;
        els.verificationCountdown.textContent = seconds;

        timer.verificationIntervalId = window.setInterval(() => {
            seconds -= 1;
            els.verificationCountdown.textContent = Math.max(0, seconds);
        }, 1000);

        timer.verificationTimeoutId = window.setTimeout(() => {
            window.clearInterval(timer.verificationIntervalId);
            timer.verificationIntervalId = null;
            timer.verificationTimeoutId = null;
            timer.checksFailed += 1;
            timer.focusViolations += 1;
            closeModal(els.verificationModal);
            updateTimerUI();
            showToast("Presence check missed. The session was flagged and remains paused.", "error");
            timer.nextVerificationAt = null;
        }, 15000);
    }

    function confirmPresence() {
        if (timer.verificationTimeoutId) window.clearTimeout(timer.verificationTimeoutId);
        if (timer.verificationIntervalId) window.clearInterval(timer.verificationIntervalId);

        timer.verificationTimeoutId = null;
        timer.verificationIntervalId = null;
        timer.checksPassed += 1;
        closeModal(els.verificationModal);
        scheduleNextVerification();
        startTimer();
        showToast("Presence confirmed. Keep going.");
    }

    function playTone(frequency = 700) {
        if (!state.settings.sound) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const context = new AudioContext();
            const oscillator = context.createOscillator();
            const gain = context.createGain();

            oscillator.type = "sine";
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);

            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.38);
        } catch (error) {
            console.warn("Sound could not be played.", error);
        }
    }

    const REFLECTION_STOPWORDS = new Set([
        "about", "above", "after", "again", "against", "all", "and", "any", "are", "because",
        "been", "before", "being", "below", "between", "both", "but", "cant", "could", "did",
        "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had",
        "has", "have", "having", "here", "hers", "herself", "him", "himself", "his", "how",
        "into", "its", "itself", "just", "learned", "learn", "learnt", "lesson", "more",
        "most", "myself", "not", "notes", "note", "now", "off", "once", "only", "other",
        "ours", "ourselves", "out", "over", "own", "same", "should", "some", "still", "study",
        "studied", "studying", "such", "than", "that", "the", "their", "theirs", "them",
        "themselves", "then", "there", "these", "they", "this", "those", "through", "today",
        "topic", "under", "until", "very", "was", "watched", "were", "what", "when", "where",
        "which", "while", "who", "whom", "why", "will", "with", "would", "your", "yours",
        "yourself", "session", "resource", "video", "document", "material", "materials"
    ]);

    function extractKeywords(text) {
        return new Set(
            (text || "")
                .toLowerCase()
                .replace(/[_\-.]/g, " ")
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter(word => word.length >= 4 && !REFLECTION_STOPWORDS.has(word))
        );
    }

    function buildResourceKeywords(resource) {
        if (!resource) return new Set();
        const fileBase = (resource.fileName || "").replace(/\.[^.]+$/, "");
        return extractKeywords(`${resource.title || ""} ${resource.notes || ""} ${fileBase}`);
    }

    function checkResourceAlignment(value, resourceKeywords) {
        if (!resourceKeywords || resourceKeywords.size < 2) {
            return { applicable: false, ok: true };
        }
        const reflectionWords = extractKeywords(value);
        const matches = [...resourceKeywords].filter(word =>
            [...reflectionWords].some(rw => rw.includes(word) || word.includes(rw))
        );
        return { applicable: true, ok: matches.length >= 1, matches };
    }

    function prepareReflectionModal() {
        const task = state.tasks.find(item => item.id === timer.pendingCompletion?.taskId);
        const resourceId = task?.resourceId || timer.pendingCompletion?.resourceId;
        const resource = resourceId ? getResource(resourceId) : null;
        timer.reflectionResourceKeywords = buildResourceKeywords(resource);

        els.reflectionResourceNote.textContent = resource
            ? `This session was logged against "${resource.title}". Mention something specific you studied from it.`
            : "";
        els.reflectionResourceNote.classList.toggle("hidden", !resource);

        els.reflectionText.value = "";
        els.reflectionCount.textContent = "0";
        els.reflectionValidation.textContent = "At least 40 characters are required.";
        els.reflectionAlignment.textContent = "";
        els.reflectionAlignment.className = "alignment-status";
        els.saveReflection.disabled = true;
        setTimeout(() => els.reflectionText.focus(), 100);
    }

    // Interactive helper: Assist student reflection writing with Gemini
    async function assistReflectionWithGemini() {
        const task = state.tasks.find(item => item.id === timer.pendingCompletion?.taskId);
        const topic = task?.title || timer.pendingCompletion?.goal || "General study topic";

        showToast("Generating reflection prompt from Gemini...", "info");

        const prompt = `I am a student writing a short summary of what I learned in a study session on: "${topic}". Give me 2 short guiding reflection bullet points or questions to help me summarize my thoughts effectively in my study log. Keep it under 40 words total.`;
        const aiResponse = await askGemini(prompt);

        if (aiResponse) {
            els.reflectionText.value = `I focused on ${topic}. ${aiResponse.replace(/[*#]/g, '')}`;
            validateReflection();
        }
    }

    function validateReflection() {
        const value = els.reflectionText.value.trim();
        els.reflectionCount.textContent = els.reflectionText.value.length;

        const hasEnoughLength = value.length >= 40;
        const hasVariety = new Set(value.toLowerCase().replace(/[^a-z0-9]/g, "")).size >= 10;
        const words = value.split(/\s+/).filter(Boolean);
        const hasWords = words.length >= 7;

        const wordCounts = {};
        words.forEach(word => {
            const key = word.toLowerCase();
            wordCounts[key] = (wordCounts[key] || 0) + 1;
        });
        const notRepetitive = words.length === 0 ||
            Math.max(...Object.values(wordCounts)) / words.length <= 0.4;

        const basicsValid = hasEnoughLength && hasVariety && hasWords && notRepetitive;

        const alignment = basicsValid
            ? checkResourceAlignment(value, timer.reflectionResourceKeywords)
            : { applicable: false, ok: true };

        const valid = basicsValid && alignment.ok;

        els.saveReflection.disabled = !valid;
        els.reflectionValidation.textContent = basicsValid
            ? ""
            : "Write at least 40 characters using seven or more varied, meaningful words.";

        if (!basicsValid) {
            els.reflectionAlignment.className = "alignment-status";
            els.reflectionAlignment.textContent = "";
        } else if (alignment.applicable && !alignment.ok) {
            els.reflectionAlignment.className = "alignment-status visible mismatch";
            els.reflectionAlignment.textContent =
                "This doesn't seem to reference the linked resource yet. Mention a specific detail, term, or idea from what you studied to log the session.";
        } else if (alignment.applicable && alignment.ok) {
            els.reflectionAlignment.className = "alignment-status visible match";
            els.reflectionAlignment.textContent = "Looks like it connects to the resource you studied. ✓";
        } else {
            els.reflectionAlignment.className = "alignment-status";
            els.reflectionAlignment.textContent = "";
        }
    }

    function stripCodeFence(value = "") {
        return String(value || "")
            .trim()
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();
    }

    function parseJsonObjectFromAi(value) {
        const cleaned = stripCodeFence(value);
        try {
            return JSON.parse(cleaned);
        } catch (_) {
            const firstBrace = cleaned.indexOf("{");
            const lastBrace = cleaned.lastIndexOf("}");
            if (firstBrace === -1 || lastBrace <= firstBrace) {
                throw new Error("The AI returned an invalid assessment response. Please try again.");
            }
            try {
                return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
            } catch (error) {
                console.error("Assessment JSON parse failed:", cleaned, error);
                throw new Error("The AI returned malformed assessment data. Please try again.");
            }
        }
    }

    async function extractResourceStudyText(resource) {
        if (!resource) return "";

        const metadata = [resource.title, resource.notes, resource.fileName, resource.url]
            .filter(Boolean).join("\n");

        if (resource.kind === "link") {
            return metadata;
        }

        const file = await getResourceFileBlob(resource);
        if (!file) return metadata;

        try {
            if (resource.mimeType === "application/pdf" && window.pdfjsLib) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
                const pages = [];
                const pageLimit = Math.min(pdf.numPages, 30);
                for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
                    const page = await pdf.getPage(pageNumber);
                    const content = await page.getTextContent();
                    pages.push(content.items.map(item => item.str).join(" "));
                }
                return `${metadata}\n\n${pages.join("\n")}`.slice(0, 60000);
            }

            if (
                resource.mimeType.startsWith("text/") ||
                /\.(txt|md|csv|json|html?|js|ts|css|py|java|c|cpp|sql)$/i.test(resource.fileName || "")
            ) {
                return `${metadata}\n\n${await file.text()}`.slice(0, 60000);
            }
        } catch (error) {
            console.warn("Could not extract resource text.", error);
        }

        return metadata;
    }

    // -------------------------------------------------------------
    // AI TUTOR CHAT — ask questions about the resource being studied.
    // Reuses extractResourceStudyText() for context and the same
    // gemini-chat edge function as the reflection/assessment flow.
    // -------------------------------------------------------------
    async function openTutorChatFor(resourceId) {
        const resource = getResource(resourceId);
        if (!resource) return showToast("Open a resource first to chat with the tutor about it.", "error");

        if (tutorChat.resourceId !== resource.id) {
            tutorChat.resourceId = resource.id;
            tutorChat.resourceTitle = resource.title;
            tutorChat.history = [];
            tutorChat.context = "";
        }

        els.tutorChatResourceNote.textContent = `About: ${resource.title}`;
        openModal(els.tutorChatModal);
        renderTutorMessages();
        setTimeout(() => els.tutorChatInput.focus(), 100);

        if (!tutorChat.context) {
            els.tutorChatMessages.innerHTML = `<p class="tutor-chat-empty">Reading the resource…</p>`;
            tutorChat.context = await extractResourceStudyText(resource);
            renderTutorMessages();
        }
    }

    function resetTutorChat() {
        tutorChat.history = [];
        renderTutorMessages();
        els.tutorChatInput.value = "";
        els.tutorChatInput.focus();
    }

    function renderTutorMessages() {
        if (!tutorChat.history.length) {
            els.tutorChatMessages.innerHTML = `<p class="tutor-chat-empty">Ask anything about "${escapeHtml(tutorChat.resourceTitle)}" — definitions, summaries, worked examples, anything unclear.</p>`;
            return;
        }

        els.tutorChatMessages.innerHTML = tutorChat.history.map(msg => `
            <div class="tutor-msg ${msg.role === "user" ? "user" : "assistant"}">${escapeHtml(msg.role === "assistant" ? stripMarkdown(msg.text) : msg.text)}</div>
        `).join("");
        els.tutorChatMessages.scrollTop = els.tutorChatMessages.scrollHeight;
    }

    function setTutorTyping(visible) {
        const existing = els.tutorChatMessages.querySelector(".tutor-msg.typing");
        if (!visible) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;
        const bubble = document.createElement("div");
        bubble.className = "tutor-msg typing";
        bubble.innerHTML = "<span></span><span></span><span></span>";
        els.tutorChatMessages.appendChild(bubble);
        els.tutorChatMessages.scrollTop = els.tutorChatMessages.scrollHeight;
    }

    async function sendTutorChatMessage(event) {
        event.preventDefault();
        if (tutorChat.sending) return;

        const question = els.tutorChatInput.value.trim();
        if (!question) return;

        const resource = getResource(tutorChat.resourceId);
        if (!resource) return showToast("That resource is no longer available.", "error");

        tutorChat.sending = true;
        els.tutorChatSend.disabled = true;
        els.tutorChatInput.value = "";
        tutorChat.history.push({ role: "user", text: question });
        renderTutorMessages();
        setTutorTyping(true);

        try {
            const historyForApi = tutorChat.history
                .slice(0, -1)
                .map(msg => ({ role: msg.role, text: msg.text }));

            if (!tutorChat.context || tutorChat.context.trim().length < 20) {
                throw new Error("There is not enough readable content in this resource for the tutor yet.");
            }

            const answer = await askGemini(question, {
                mode: "tutor",
                resourceTitle: tutorChat.resourceTitle,
                resourceContext: tutorChat.context.slice(0, 60000),
                chatHistory: historyForApi.slice(-12)
            });

            setTutorTyping(false);

            tutorChat.history.push({ role: "assistant", text: answer });
            renderTutorMessages();
        } catch (error) {
            console.error("Tutor chat failed:", error);
            setTutorTyping(false);
            tutorChat.history.push({
                role: "assistant",
                text: error?.message || "The tutor is temporarily unavailable. Please try again."
            });
            renderTutorMessages();
        } finally {
            tutorChat.sending = false;
            els.tutorChatSend.disabled = false;
            els.tutorChatInput.focus();
        }
    }

    function normaliseAssessment(payload) {
        const objective = Array.isArray(payload?.objectiveQuestions) ? payload.objectiveQuestions : [];
        const theory = Array.isArray(payload?.theoryQuestions) ? payload.theoryQuestions : [];
        return {
            aligned: payload?.aligned === true,
            alignmentScore: Math.max(0, Math.min(100, Number(payload?.alignmentScore) || 0)),
            feedback: String(payload?.feedback || ""),
            objectiveQuestions: objective.slice(0, 10).map((item, index) => ({
                question: String(item?.question || `Question ${index + 1}`),
                options: Array.isArray(item?.options) ? item.options.slice(0, 4).map(String) : [],
                correctAnswer: Math.max(0, Math.min(3, Number(item?.correctAnswer) || 0)),
                explanation: String(item?.explanation || "")
            })),
            theoryQuestions: theory.slice(0, 2).map((item, index) => ({
                question: String(item?.question || `Theory question ${index + 1}`),
                modelAnswer: String(item?.modelAnswer || "")
            }))
        };
    }

    async function verifySummaryAndGenerateAssessment(summary, resource, task) {
        const resourceText = await extractResourceStudyText(resource);
        if (!resourceText || resourceText.trim().length < 30) {
            throw new Error("There is not enough readable resource content to verify the summary. Add detailed resource notes or upload a readable PDF/text file.");
        }

        const prompt = `You are verifying a student's study summary against the exact resource they studied.

RESOURCE TITLE: ${resource?.title || task?.title || "Study resource"}
RESOURCE CONTENT:\n${resourceText}

STUDENT SUMMARY:\n${summary}

Return ONLY valid JSON with this exact structure:
{
  "aligned": true,
  "alignmentScore": 0,
  "feedback": "brief evidence-based feedback",
  "objectiveQuestions": [
    {"question":"", "options":["","","",""], "correctAnswer":0, "explanation":""}
  ],
  "theoryQuestions": [
    {"question":"", "modelAnswer":""}
  ]
}

Rules:
- aligned must be true only when the summary contains accurate, meaningful ideas supported by the resource, not merely matching its title.
- alignmentScore is 0-100. Require at least 60 for aligned=true.
- Generate exactly 10 objective multiple-choice questions with exactly 4 options each.
- correctAnswer must be the zero-based index of the correct option.
- Generate exactly 2 theory questions and concise model answers.
- Every question and answer must be directly supported by the supplied resource.
- Do not introduce outside facts.`;

        const response = await askGemini(prompt, { mode: "assessment" });
        if (!response) throw new Error("The resource check could not be completed.");
        const assessment = normaliseAssessment(parseJsonObjectFromAi(response));
        if (assessment.objectiveQuestions.length !== 10 || assessment.objectiveQuestions.some(q => q.options.length !== 4) || assessment.theoryQuestions.length !== 2) {
            throw new Error("The generated assessment was incomplete. Please try again.");
        }
        return assessment;
    }

    function renderAssessment(assessment) {
        els.assessmentSummaryStatus.className = `assessment-summary-status ${assessment.aligned ? "match" : "mismatch"}`;
        els.assessmentSummaryStatus.innerHTML = `<strong>${assessment.aligned ? "Summary confirmed" : "Summary needs correction"} — ${assessment.alignmentScore}% alignment</strong><p>${escapeHtml(assessment.feedback)}</p>`;

        els.objectiveQuestions.innerHTML = assessment.objectiveQuestions.map((item, index) => `
            <fieldset class="assessment-question">
                <legend>${index + 1}. ${escapeHtml(item.question)}</legend>
                ${item.options.map((option, optionIndex) => `
                    <label class="assessment-option">
                        <input type="radio" name="objective-${index}" value="${optionIndex}">
                        <span>${escapeHtml(option)}</span>
                    </label>`).join("")}
            </fieldset>`).join("");

        els.theoryQuestions.innerHTML = assessment.theoryQuestions.map((item, index) => `
            <label class="assessment-question theory-question">
                <strong>${index + 1}. ${escapeHtml(item.question)}</strong>
                <textarea class="form-control" rows="4" minlength="20" maxlength="1000" data-theory-answer="${index}" placeholder="Answer in your own words..."></textarea>
            </label>`).join("");
        els.assessmentValidation.textContent = "";
    }
    async function saveReflection() {
        if (!timer.pendingCompletion || els.saveReflection.disabled) return;

        const task = state.tasks.find(item => item.id === timer.pendingCompletion.taskId);
        const resourceId = task?.resourceId || timer.pendingCompletion.resourceId;
        const resource = resourceId ? getResource(resourceId) : null;
        const summary = els.reflectionText.value.trim();

        if (!resource) {
            showToast("Link a study resource to this task before the summary can be verified.", "error");
            return;
        }

        els.saveReflection.disabled = true;
        els.saveReflection.textContent = "Checking summary…";
        els.reflectionAlignment.className = "alignment-status visible";
        els.reflectionAlignment.textContent = "Comparing your summary with the resource and preparing your assessment…";

        try {
            const assessment = await verifySummaryAndGenerateAssessment(summary, resource, task);

            if (!assessment.aligned) {
                els.reflectionAlignment.className = "alignment-status visible mismatch";
                els.reflectionAlignment.textContent = `${assessment.feedback} Alignment score: ${assessment.alignmentScore}%. Revise the summary before continuing.`;
                return;
            }

            timer.pendingAssessment = { assessment, summary, resourceId: resource.id };
            renderAssessment(assessment);
            closeModal(els.reflectionModal);
            openModal(els.assessmentModal);

        } catch (error) {
            console.error("Reflection verification failed:", error);
            els.reflectionAlignment.className = "alignment-status visible mismatch";
            els.reflectionAlignment.textContent = error.message || "The summary could not be checked. Please try again.";
        } finally {
            // Reset button text and force re-evaluation of disabled state
            els.saveReflection.textContent = "Check summary & continue";

            // Re-enable the button if summary meets length requirements
            if (typeof validateReflection === 'function') {
                validateReflection();
            } else {
                els.saveReflection.disabled = false;
            }
        }
    }

    // -------------------------------------------------------------
    // Post-submission results review ("explanation-on-demand")
    //
    // Builds a lightweight review modal on the fly (reusing the same
    // .modal-backdrop / .modal-card / .assessment-question CSS classes
    // already defined for the assessment modal, so no new styles are
    // needed) that shows each objective question with the student's
    // answer, the correct answer, and the explanation Gemini already
    // generated in normaliseAssessment(). This data was previously
    // discarded after scoring.
    // -------------------------------------------------------------
    function openAssessmentResultsModal(assessment, objectiveAnswers, theoryAnswers, objectiveScore, onContinue) {
        const backdrop = document.createElement("div");
        backdrop.className = "modal-backdrop";

        const objectiveHtml = assessment.objectiveQuestions.map((item, index) => {
            const selected = objectiveAnswers[index];
            const correct = item.correctAnswer;
            const isCorrect = selected === correct;
            const optionsHtml = item.options.map((option, optionIndex) => {
                let marker = "";
                let style = "";
                if (optionIndex === correct) {
                    marker = "✓ ";
                    style = "color:var(--success);font-weight:700;";
                } else if (optionIndex === selected) {
                    marker = "✗ ";
                    style = "color:var(--danger);font-weight:700;";
                }
                return `<label class="assessment-option" style="${style}"><span>${marker}${escapeHtml(option)}</span></label>`;
            }).join("");

            return `
                <fieldset class="assessment-question">
                    <legend>${index + 1}. ${escapeHtml(item.question)}
                        <span style="margin-left:8px;font-weight:800;color:${isCorrect ? "var(--success)" : "var(--danger)"};">
                            ${isCorrect ? "Correct" : "Incorrect"}
                        </span>
                    </legend>
                    ${optionsHtml}
                    ${item.explanation ? `<p style="margin:12px 4px 0;color:var(--muted);font-size:.8rem;line-height:1.55;"><strong style="color:var(--text);">Why:</strong> ${escapeHtml(item.explanation)}</p>` : ""}
                </fieldset>
            `;
        }).join("");

        const theoryHtml = assessment.theoryQuestions.map((item, index) => `
            <div class="assessment-question theory-question">
                <strong>${index + 1}. ${escapeHtml(item.question)}</strong>
                <p style="margin:0;color:var(--text);line-height:1.6;"><strong>Your answer:</strong> ${escapeHtml(theoryAnswers[index] || "")}</p>
                <p style="margin:0;color:var(--muted);line-height:1.6;"><strong>Model answer:</strong> ${escapeHtml(item.modelAnswer)}</p>
            </div>
        `).join("");

        backdrop.innerHTML = `
            <div class="modal-card assessment-card">
                <div class="modal-header">
                    <div>
                        <p class="eyebrow">Session results</p>
                        <h3>Review your answers</h3>
                    </div>
                </div>
                <div class="assessment-summary-status ${objectiveScore >= 6 ? "match" : "mismatch"}">
                    <strong>Objective score: ${objectiveScore}/${assessment.objectiveQuestions.length}</strong>
                    <p>Go through each question below to see the correct answer and why it's correct.</p>
                </div>
                <section class="assessment-section">
                    <h4>Objective questions</h4>
                    <div class="assessment-question-list">${objectiveHtml}</div>
                </section>
                <section class="assessment-section">
                    <h4>Theory questions</h4>
                    <div class="assessment-question-list">${theoryHtml}</div>
                </section>
                <div class="modal-actions">
                    <button class="primary-button" id="closeAssessmentResultsButton">Continue</button>
                </div>
            </div>
        `;

        document.body.appendChild(backdrop);
        openModal(backdrop);

        const finish = () => {
            closeModal(backdrop);
            backdrop.remove();
            if (typeof onContinue === "function") onContinue();
        };

        backdrop.querySelector("#closeAssessmentResultsButton").addEventListener("click", finish);
        backdrop.addEventListener("mousedown", event => {
            if (event.target === backdrop) finish();
        });
    }

    function submitAssessment(event) {
        event.preventDefault();
        if (!timer.pendingCompletion || !timer.pendingAssessment) return;

        const { assessment, summary, resourceId } = timer.pendingAssessment;
        const objectiveAnswers = assessment.objectiveQuestions.map((_, index) => {
            const selected = els.assessmentForm.querySelector(`input[name="objective-${index}"]:checked`);
            return selected ? Number(selected.value) : null;
        });
        const theoryAnswers = [...els.assessmentForm.querySelectorAll("[data-theory-answer]")].map(input => input.value.trim());

        if (objectiveAnswers.some(answer => answer === null) || theoryAnswers.some(answer => answer.length < 20)) {
            els.assessmentValidation.textContent = "Answer all 10 objective questions and both theory questions. Each theory answer must contain at least 20 characters.";
            return;
        }

        const objectiveScore = objectiveAnswers.reduce((score, answer, index) =>
            score + (answer === assessment.objectiveQuestions[index].correctAnswer ? 1 : 0), 0);
        const task = state.tasks.find(item => item.id === timer.pendingCompletion.taskId);
        const session = {
            id: crypto.randomUUID(),
            ...timer.pendingCompletion,
            taskTitle: task?.title || "General study session",
            resourceId,
            reflection: summary,
            summaryAlignmentScore: assessment.alignmentScore,
            assessment: {
                objectiveScore,
                objectiveTotal: 10,
                objectiveAnswers,
                objectiveQuestions: assessment.objectiveQuestions,
                theoryAnswers,
                theoryQuestions: assessment.theoryQuestions
            },
            integrity: timer.pendingCompletion.focusViolations === 0 && timer.pendingCompletion.checksFailed === 0 ? "verified" : "flagged"
        };

        state.sessions.push(session);
        if (task && task.status === "todo") task.status = "inProgress";
        saveState();
        closeModal(els.assessmentModal);
        timer.pendingCompletion = null;
        timer.pendingAssessment = null;
        timer.reflectionResourceKeywords = null;

        // Show the review-your-answers screen (with explanations) before
        // advancing the timer, instead of jumping straight to the next
        // break/focus cycle.
        openAssessmentResultsModal(assessment, objectiveAnswers, theoryAnswers, objectiveScore, () => {
            const nextMode = timer.cycle >= state.settings.cyclesBeforeLongBreak ? "longBreak" : "shortBreak";
            if (timer.cycle >= state.settings.cyclesBeforeLongBreak) timer.cycle = 1;
            else timer.cycle += 1;
            setTimerMode(nextMode, true);
            els.sessionGoal.value = "";
            els.goalCount.textContent = "0";
            renderAll();
            showToast(`Verified session logged. Objective score: ${objectiveScore}/10.`);
        });
    }

    function backToReflection() {
        closeModal(els.assessmentModal);
        openModal(els.reflectionModal);
        timer.pendingAssessment = null;
        validateReflection();
    }

    function discardSession() {
        if (!window.confirm("Discard this completed session without logging it?")) return;
        timer.pendingCompletion = null;
        timer.pendingAssessment = null;
        timer.reflectionResourceKeywords = null;
        closeModal(els.reflectionModal);

        const nextMode =
            timer.cycle >= state.settings.cyclesBeforeLongBreak ? "longBreak" : "shortBreak";
        if (timer.cycle >= state.settings.cyclesBeforeLongBreak) timer.cycle = 1;
        else timer.cycle += 1;

        setTimerMode(nextMode, true);
        showToast("Session discarded.", "warning");
    }

    function renderProgress() {
        const totalMinutes = state.sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
        const streaks = calculateStreaks();
        const completed = state.tasks.filter(task => task.status === "done").length;
        const completionRate = state.tasks.length ? Math.round((completed / state.tasks.length) * 100) : 0;
        const weeklyMinutes = getWeeklyMinutes();
        const weeklyPercent = Math.min(100, Math.round((weeklyMinutes / state.settings.weeklyGoalMinutes) * 100));

        els.progressStreak.textContent = streaks.current;
        els.longestStreak.textContent = streaks.longest;
        els.progressTotalTime.textContent = formatMinutes(totalMinutes);
        els.completionRate.textContent = `${completionRate}%`;
        els.weeklyGoalPercent.textContent = `${weeklyPercent}%`;
        els.weeklyGoalCaption.textContent = `${Math.round(weeklyMinutes)} of ${state.settings.weeklyGoalMinutes} minutes`;
        els.goalRing.style.setProperty("--goal-progress", `${weeklyPercent * 3.6}deg`);

        renderBarChart(els.progressChart, getLastSevenDays(), true);
        renderHistory();
    }

    function renderHistory() {
        const sessions = [...state.sessions].sort((a, b) => b.completedAt - a.completedAt);

        els.historyBody.innerHTML = sessions.length
            ? sessions.map(session => `
        <tr>
          <td>${formatDate(session.completedAt)}</td>
          <td>${escapeHtml(session.taskTitle || "General study session")}</td>
          <td>${session.durationMinutes} min</td>
          <td>
            <span class="integrity-badge ${session.integrity === "verified" ? "integrity-good" : "integrity-flagged"
                }">
              ${session.integrity === "verified" ? "Verified" : "Flagged"}
            </span>
          </td>
          <td>
            <button class="text-button" data-view-reflection="${session.id}">View</button>
            ${session.assessment ? `<button class="text-button" data-view-results="${session.id}">Results</button>` : ""}
          </td>
        </tr>
      `).join("")
            : `<tr><td colspan="5"><div class="empty-state">No completed sessions yet.</div></td></tr>`;
    }

    function viewReflection(id) {
        const session = state.sessions.find(item => item.id === id);
        if (!session) return;
        els.reflectionViewTitle.textContent = session.taskTitle || "Session reflection";
        els.reflectionViewText.textContent = session.reflection;
        openModal(els.reflectionViewModal);
    }

    // Re-open the explanation-on-demand review for a past session from
    // the session history table, reusing the same modal builder used
    // right after submission.
    function viewSessionResults(id) {
        const session = state.sessions.find(item => item.id === id);
        if (!session || !session.assessment) return;
        const assessment = {
            objectiveQuestions: session.assessment.objectiveQuestions,
            theoryQuestions: session.assessment.theoryQuestions
        };
        openAssessmentResultsModal(
            assessment,
            session.assessment.objectiveAnswers,
            session.assessment.theoryAnswers,
            session.assessment.objectiveScore,
            () => { }
        );
    }

    function populateSettings() {
        els.focusMinutesSetting.value = state.settings.focusMinutes;
        els.shortBreakSetting.value = state.settings.shortBreakMinutes;
        els.longBreakSetting.value = state.settings.longBreakMinutes;
        els.cyclesSetting.value = state.settings.cyclesBeforeLongBreak;
        els.weeklyGoalSetting.value = state.settings.weeklyGoalMinutes;
        state.settings.focusTracking = true;
        state.settings.verificationChecks = true;
        state.settings.sound = true;
        els.focusTrackingSetting.checked = true;
        els.verificationSetting.checked = true;
        els.soundSetting.checked = true;
    }

    function saveSettings() {
        const next = {
            focusMinutes: Number(els.focusMinutesSetting.value),
            shortBreakMinutes: Number(els.shortBreakSetting.value),
            longBreakMinutes: Number(els.longBreakSetting.value),
            cyclesBeforeLongBreak: Number(els.cyclesSetting.value),
            weeklyGoalMinutes: Number(els.weeklyGoalSetting.value),
            focusTracking: true,
            verificationChecks: true,
            sound: true,
            theme: state.settings.theme
        };

        const valid =
            next.focusMinutes >= 1 && next.focusMinutes <= 180 &&
            next.shortBreakMinutes >= 1 && next.shortBreakMinutes <= 60 &&
            next.longBreakMinutes >= 1 && next.longBreakMinutes <= 90 &&
            next.cyclesBeforeLongBreak >= 1 && next.cyclesBeforeLongBreak <= 10 &&
            next.weeklyGoalMinutes >= 30 && next.weeklyGoalMinutes <= 10080;

        if (!valid) {
            showToast("Please check the timer and weekly goal values.", "error");
            return;
        }

        state.settings = next;
        saveState();

        if (!timer.running) setTimerMode(timer.mode, true);
        renderAll();
        showToast("Settings saved.");
    }

    async function resetAllData() {
        if (!window.confirm("Reset every task, session, and setting stored for this user?")) return;
        if (!window.confirm("This cannot be undone. Continue?")) return;

        if (currentUser) {
            localStorage.removeItem(getStorageKey(currentUser.id));
        }
        state = structuredClone(defaultState);

        if (currentUser) {
            try {
                const { error } = await supabase
                    .from(STATE_TABLE)
                    .upsert(
                        { user_id: currentUser.id, data: state, updated_at: new Date().toISOString() },
                        { onConflict: "user_id" }
                    );
                if (error) throw error;
            } catch (error) {
                console.error("Could not reset cloud state.", error);
                showToast("Local data was reset, but the cloud copy could not be cleared. Try again when you're back online.", "error");
            }
        }

        timer.cycle = 1;
        setTimerMode("focus", true);
        populateSettings();
        applyTheme();
        renderAll();
        navigate("dashboard");
        showToast("All user app data has been reset.", "warning");
    }

    // -------------------------------------------------------------
    // SUPABASE STORAGE — resource files, synced across every device
    // a student signs into. Replaces the old per-browser IndexedDB
    // cache: files now live in the `study-resources` bucket under a
    // path scoped to the signed-in user's id.
    // -------------------------------------------------------------

    function sanitiseFileName(name = "file") {
        const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
        return cleaned.slice(-140) || "file";
    }

    function resourceStoragePath(userId, id, fileName) {
        return `${userId}/${id}-${sanitiseFileName(fileName)}`;
    }

    async function uploadResourceFile(id, file) {
        if (!currentUser) throw new Error("You must be signed in to upload a resource.");
        const path = resourceStoragePath(currentUser.id, id, file.name);
        const { error } = await supabase.storage
            .from(RESOURCE_BUCKET)
            .upload(path, file, { upsert: true, contentType: file.type || "application/octet-stream" });
        if (error) throw error;
        return path;
    }

    async function getResourceFileBlob(resource) {
        if (!resource?.storagePath) return null;
        try {
            const { data, error } = await supabase.storage
                .from(RESOURCE_BUCKET)
                .download(resource.storagePath);
            if (error) throw error;
            return data;
        } catch (error) {
            console.warn("Could not download resource file from cloud storage.", error);
            return null;
        }
    }

    async function removeResourceFile(storagePath) {
        if (!storagePath) return;
        const { error } = await supabase.storage.from(RESOURCE_BUCKET).remove([storagePath]);
        if (error) console.warn("Could not remove resource file from cloud storage.", error);
    }

    function getResource(id) { return state.resources.find(item => item.id === id); }

    function toggleResourceFields() {
        const isLink = els.resourceKind.value === "link";
        els.resourceFileGroup.classList.toggle("hidden", isLink);
        els.resourceUrlGroup.classList.toggle("hidden", !isLink);
    }

    // -------------------------------------------------------------
    // Custom file-drop control for #resourceFile
    // Replaces the native <input type="file"> "Choose file" chrome with
    // a themed drop zone: shows a type-aware icon, filename + size once
    // a file is chosen, and a clear (✕) button. The underlying native
    // input is still what saveResource() reads from — only its visual
    // presentation changes.
    // -------------------------------------------------------------
    function fileKindLabel(file) {
        const type = file.type || "";
        if (type.startsWith("video/")) return { icon: "🎬", label: "Video selected" };
        if (type.startsWith("audio/")) return { icon: "🎧", label: "Audio selected" };
        if (type.startsWith("image/")) return { icon: "🖼️", label: "Image selected" };
        if (type === "application/pdf") return { icon: "📄", label: "PDF selected" };
        return { icon: "📄", label: "File selected" };
    }

    function updateFileDropDisplay() {
        if (!els.resourceFileDrop) return;
        const file = els.resourceFile.files[0];
        if (!file) {
            els.resourceFileDrop.classList.remove("has-file");
            els.resourceFileIcon.textContent = "📎";
            els.resourceFileLabel.textContent = "Choose a document or video";
            els.resourceFileName.textContent = "No file chosen";
            return;
        }
        const { icon, label } = fileKindLabel(file);
        els.resourceFileDrop.classList.add("has-file");
        els.resourceFileIcon.textContent = icon;
        els.resourceFileLabel.textContent = label;
        els.resourceFileName.textContent = `${file.name} · ${humanFileSize(file.size)}`;
    }

    function clearFileDrop() {
        els.resourceFile.value = "";
        updateFileDropDisplay();
    }

    function bindFileDropEvents() {
        if (!els.resourceFileDrop) return;
        els.resourceFile.addEventListener("change", updateFileDropDisplay);
        els.resourceFileClear.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            clearFileDrop();
        });
    }

    async function saveResource(event) {
        event.preventDefault();
        const kind = els.resourceKind.value;
        const file = els.resourceFile.files[0];
        const url = els.resourceUrl.value.trim();
        if (kind === "file" && !file) return showToast("Choose a document or video to upload.", "error");
        if (kind === "link" && !url) return showToast("Enter a valid resource URL.", "error");

        const id = crypto.randomUUID();
        let type = "link";
        let mimeType = "";
        let fileName = "";
        let fileSize = 0;
        let storagePath = "";

        if (file) {
            mimeType = file.type || "application/octet-stream";
            fileName = file.name;
            fileSize = file.size;
            type = mimeType.startsWith("video/") || mimeType.startsWith("audio/") ? "video" : "document";

            const submitButton = els.resourceSubmitButton;
            const originalLabel = submitButton ? submitButton.textContent : "";
            if (submitButton) { submitButton.disabled = true; submitButton.textContent = "Uploading…"; }

            try {
                storagePath = await uploadResourceFile(id, file);
            } catch (error) {
                console.error(error);
                showToast("This file could not be uploaded to your cloud library. Check your connection and try again.", "error");
                return;
            } finally {
                if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
            }
        }

        state.resources.unshift({ id, title: els.resourceTitle.value.trim(), type, kind, url, mimeType, fileName, fileSize, storagePath, notes: els.resourceNotes.value.trim(), createdAt: Date.now() });
        saveState();
        closeModal(els.resourceModal);
        renderAll();
        showToast(file ? "Resource uploaded to your cloud library — available on every device." : "Resource saved to your study library.");
    }

    function resourceIcon(resource) { return resource.type === "video" ? "🎬" : resource.type === "link" ? "🔗" : "📄"; }
    function humanFileSize(bytes = 0) { if (!bytes) return "Web resource"; const units = ["B", "KB", "MB", "GB"]; let i = 0, n = bytes; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; }

    function renderResources() {
        const query = (els.resourceSearch?.value || "").trim().toLowerCase();
        const filter = els.resourceTypeFilter?.value || "all";
        const resources = state.resources.filter(resource => (!query || `${resource.title} ${resource.notes} ${resource.fileName}`.toLowerCase().includes(query)) && (filter === "all" || resource.type === filter));
        els.documentCount.textContent = state.resources.filter(r => r.type === "document").length;
        els.videoCount.textContent = state.resources.filter(r => r.type === "video").length;
        els.linkCount.textContent = state.resources.filter(r => r.type === "link").length;
        els.resourceGrid.innerHTML = resources.length ? resources.map(resource => `
      <article class="resource-card">
        <div class="resource-card__icon">${resourceIcon(resource)}</div>
        <div class="resource-card__content"><span class="resource-type">${resource.type}</span><h3>${escapeHtml(resource.title)}</h3><p>${escapeHtml(resource.notes || resource.fileName || "Ready to study")}</p><small>${resource.fileName ? humanFileSize(resource.fileSize) : "External link"}</small></div>
        <div class="resource-card__actions"><button class="primary-button" data-open-resource="${resource.id}">Open & study</button><button class="secondary-button" data-plan-resource="${resource.id}">Plan task</button><button class="danger-text-button" data-delete-resource="${resource.id}">Delete</button></div>
      </article>`).join("") : `<div class="empty-state resource-empty">No resources yet. Upload a document, video, or add a learning link.</div>`;
        populateTaskResources();
    }

    function populateTaskResources() {
        const current = els.taskResource?.value || "";
        if (!els.taskResource) return;
        els.taskResource.innerHTML = `<option value="">No linked resource</option>${state.resources.map(r => `<option value="${r.id}">${escapeHtml(r.title)}</option>`).join("")}`;
        if (state.resources.some(r => r.id === current)) els.taskResource.value = current;
    }

    function revokeBlobUrl() {
        if (currentBlobUrl) {
            URL.revokeObjectURL(currentBlobUrl);
            currentBlobUrl = null;
        }
    }

    // -------------------------------------------------------------
    // IN-APP RESOURCE VIEWER
    //
    // Every resource type below is rendered *inside* this page — no
    // resource ever causes a real navigation away from the Study
    // Companion, so the browser never has a reason to hand off to an
    // external app (the actual root cause of the mobile "Open with…"
    // problem). PDFs are rendered with pdf.js onto a <canvas> instead
    // of relying on the platform's native PDF plugin (which mobile
    // Chrome/Android often lacks inside an <iframe>, triggering the
    // external hand-off). Only the explicit "unsupported file type"
    // fallback link is a real, user-initiated external navigation —
    // and that is intentional by design (see isResourceViewerOpen()
    // below for how this interacts with the integrity system).
    // -------------------------------------------------------------

    // Tracks any cleanup needed for whatever is currently loaded into the
    // workspace viewer (cancel an in-flight PDF render, remove pinch-zoom
    // touch listeners, etc.) so switching or closing resources can't leak.
    let activeViewerCleanup = null;

    // -------------------------------------------------------------
    // resourceViewerOpen — derived, not a settable flag.
    //
    // The integrity system needs to know whether the student is
    // "still inside the Study Companion" even though the resource
    // viewer is showing instead of the timer. Rather than a bare
    // boolean anyone could flip from the console, this reads the
    // real application state that everything else in the app also
    // reads and writes: is a resource actually loaded
    // (timer.activeResourceId) AND is the workspace panel that shows
    // it actually visible in the DOM right now. Both of those are
    // only ever set together, by openStudyResource()/closeStudyWorkspace(),
    // which are themselves only reachable through real UI navigation
    // (clicking "Open & study", clicking "Back"). There is no code
    // path that sets one without the other.
    // -------------------------------------------------------------
    function isResourceViewerOpen() {
        return Boolean(
            timer.activeResourceId &&
            els.studyWorkspace &&
            !els.studyWorkspace.classList.contains("hidden")
        );
    }

    function isTextLikeResource(resource) {
        return (
            resource.mimeType.startsWith("text/") ||
            /\.(txt|md|csv|json|log)$/i.test(resource.fileName || "")
        );
    }

    function teardownResourceViewer() {
        if (typeof activeViewerCleanup === "function") {
            try { activeViewerCleanup(); } catch (error) { console.warn("Viewer cleanup failed.", error); }
        }
        activeViewerCleanup = null;
        revokeBlobUrl();
    }

    async function openStudyResource(id, taskId = "") {
        const resource = getResource(id);
        if (!resource) return showToast("That resource is no longer available.", "error");

        // Tear down whatever the previous resource left behind (blob URLs,
        // pinch-zoom listeners, in-flight PDF page renders) before loading
        // the next one.
        teardownResourceViewer();

        timer.activeResourceId = resource.id;

        els.workspaceTitle.textContent = resource.title;
        els.workspaceViewer.innerHTML = `<div class="viewer-loading">Opening resource…</div>`;
        els.studyWorkspace.classList.remove("hidden");
        navigate("timer");
        els.sessionTask.value = taskId || "";

        if (resource.kind === "link") {
            renderLinkViewer(resource);
            els.studyWorkspace.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        }

        const file = await getResourceFileBlob(resource);
        if (!file) {
            els.workspaceViewer.innerHTML = `<div class="empty-state">This file could not be loaded from your cloud library. Check your connection and try again.</div>`;
            els.studyWorkspace.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        }

        currentBlobUrl = URL.createObjectURL(file);

        try {
            if (resource.mimeType === "application/pdf") {
                await renderPdfViewer(resource, file);
            } else if (resource.mimeType.startsWith("image/")) {
                renderImageViewer(resource, currentBlobUrl);
            } else if (resource.mimeType.startsWith("video/")) {
                renderVideoViewer(resource, currentBlobUrl);
            } else if (resource.mimeType.startsWith("audio/")) {
                renderAudioViewer(resource, currentBlobUrl);
            } else if (isTextLikeResource(resource)) {
                await renderTextViewer(resource, file);
            } else {
                renderUnsupportedViewer(resource, currentBlobUrl, false);
            }
        } catch (error) {
            console.warn("Resource viewer failed to render — falling back to a download option.", error);
            renderUnsupportedViewer(resource, currentBlobUrl, true);
        }

        els.studyWorkspace.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function renderLinkViewer(resource) {
        const safeUrl = escapeHtml(resource.url);
        const youtube = resource.url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
        if (youtube) {
            els.workspaceViewer.innerHTML = `<iframe src="https://www.youtube.com/embed/${youtube[1]}" title="${escapeHtml(resource.title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
            return;
        }
        els.workspaceViewer.innerHTML = `
            <div class="external-resource">
                <div class="resource-card__icon">🔗</div>
                <h3>${escapeHtml(resource.title)}</h3>
                <p>This is a web link, so it opens on its original website in a new browser tab.</p>
                <a class="primary-button link-button" href="${safeUrl}" target="_blank" rel="noopener">Open link in new tab</a>
            </div>`;
    }

    // Images: rendered directly in-page with a lightweight custom
    // pinch-to-zoom / double-tap-to-zoom / drag-to-pan controller, plus
    // on-screen +/- buttons for desktop and accessibility. No native
    // browser zoom or navigation is involved.
    function renderImageViewer(resource, blobUrl) {
        els.workspaceViewer.innerHTML = `
            <div class="image-lightbox" id="imageLightbox">
                <div class="image-lightbox__stage">
                    <img src="${blobUrl}" alt="${escapeHtml(resource.title)}" id="lightboxImage" draggable="false" />
                </div>
                <div class="viewer-toolbar image-toolbar">
                    <button type="button" class="icon-button" id="imageZoomOut" aria-label="Zoom out">−</button>
                    <span id="imageZoomLevel">100%</span>
                    <button type="button" class="icon-button" id="imageZoomIn" aria-label="Zoom in">+</button>
                    <button type="button" class="secondary-button" id="imageZoomReset">Reset</button>
                </div>
            </div>`;
        activeViewerCleanup = attachImageZoom();
    }

    function attachImageZoom() {
        const stage = els.workspaceViewer.querySelector(".image-lightbox__stage");
        const img = document.getElementById("lightboxImage");
        const zoomLevelLabel = document.getElementById("imageZoomLevel");
        const zoomInButton = document.getElementById("imageZoomIn");
        const zoomOutButton = document.getElementById("imageZoomOut");
        const zoomResetButton = document.getElementById("imageZoomReset");
        if (!stage || !img) return null;

        let scale = 1;
        let originX = 0;
        let originY = 0;
        let isPanning = false;
        let panStartX = 0;
        let panStartY = 0;
        let pinchStartDistance = 0;
        let pinchStartScale = 1;
        let lastTapTime = 0;

        function applyTransform() {
            img.style.transform = `translate(${originX}px, ${originY}px) scale(${scale})`;
            zoomLevelLabel.textContent = `${Math.round(scale * 100)}%`;
            stage.classList.toggle("zoomed", scale > 1);
        }

        function setScale(next) {
            scale = Math.min(4, Math.max(1, next));
            if (scale === 1) { originX = 0; originY = 0; }
            applyTransform();
        }

        function pointerDistance(touches) {
            const [a, b] = touches;
            return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        }

        function onTouchStart(event) {
            if (event.touches.length === 2) {
                pinchStartDistance = pointerDistance(event.touches);
                pinchStartScale = scale;
            } else if (event.touches.length === 1 && scale > 1) {
                isPanning = true;
                panStartX = event.touches[0].clientX - originX;
                panStartY = event.touches[0].clientY - originY;
            }
        }

        function onTouchMove(event) {
            if (event.touches.length === 2) {
                event.preventDefault();
                const distance = pointerDistance(event.touches);
                if (pinchStartDistance > 0) setScale(pinchStartScale * (distance / pinchStartDistance));
            } else if (event.touches.length === 1 && isPanning) {
                event.preventDefault();
                originX = event.touches[0].clientX - panStartX;
                originY = event.touches[0].clientY - panStartY;
                applyTransform();
            }
        }

        function onTouchEnd() {
            isPanning = false;
            const now = Date.now();
            if (now - lastTapTime < 320) setScale(scale > 1 ? 1 : 2);
            lastTapTime = now;
        }

        stage.addEventListener("touchstart", onTouchStart, { passive: true });
        stage.addEventListener("touchmove", onTouchMove, { passive: false });
        stage.addEventListener("touchend", onTouchEnd);
        zoomInButton.addEventListener("click", () => setScale(scale + 0.5));
        zoomOutButton.addEventListener("click", () => setScale(scale - 0.5));
        zoomResetButton.addEventListener("click", () => setScale(1));
        img.addEventListener("dblclick", () => setScale(scale > 1 ? 1 : 2));

        return () => {
            stage.removeEventListener("touchstart", onTouchStart);
            stage.removeEventListener("touchmove", onTouchMove);
            stage.removeEventListener("touchend", onTouchEnd);
        };
    }

    // Video/audio: native <video>/<audio> with `playsinline` so Android
    // and iOS play the media inline inside this page instead of handing
    // off to a native fullscreen/system player (the other common cause
    // of an unwanted "left the app" moment on mobile).
    function renderVideoViewer(resource, blobUrl) {
        els.workspaceViewer.innerHTML = `<video controls playsinline webkit-playsinline preload="metadata" src="${blobUrl}"></video>`;
    }

    function renderAudioViewer(resource, blobUrl) {
        els.workspaceViewer.innerHTML = `
            <div class="audio-player-wrap">
                <div class="resource-card__icon">🎧</div>
                <p>${escapeHtml(resource.title)}</p>
                <audio controls preload="metadata" src="${blobUrl}"></audio>
            </div>`;
    }

    async function renderTextViewer(resource, file) {
        const text = await file.text();
        els.workspaceViewer.innerHTML = `<pre class="text-viewer">${escapeHtml(text)}</pre>`;
    }

    // Unsupported file types never redirect automatically. The student
    // gets a plain explanation plus an explicit, deliberate "download or
    // open externally" action — the one case in this viewer where
    // choosing to proceed really does mean leaving the Study Companion,
    // so normal integrity behaviour is expected to apply if that happens.
    function renderUnsupportedViewer(resource, blobUrl, isFallback) {
        const message = isFallback
            ? "This file couldn't be opened in the built-in viewer."
            : "The Study Companion can't preview this file type directly.";
        const meta = [
            (resource.fileName || "").split(".").pop()?.toUpperCase() || null,
            resource.fileSize ? humanFileSize(resource.fileSize) : null
        ].filter(Boolean).join(" · ");
        els.workspaceViewer.innerHTML = `
            <div class="external-resource">
                <div class="resource-card__icon">📄</div>
                <h3>${escapeHtml(resource.fileName || resource.title)}</h3>
                ${meta ? `<p class="external-resource__meta">${escapeHtml(meta)}</p>` : ""}
                <p>${message} You can download it or open it in another app instead.</p>
                <a class="primary-button link-button" href="${blobUrl}" download="${escapeHtml(resource.fileName || resource.title)}" target="_blank" rel="noopener">Download / open externally</a>
            </div>`;
    }

    // PDFs: rendered page-by-page onto a <canvas> using pdf.js, with
    // page navigation and zoom controls, inside a natively touch-
    // scrollable container. This is the core fix for the mobile bug —
    // there is no native PDF plugin dependency and no iframe pointed at
    // a blob URL, so mobile Chrome never has a reason to offer an
    // "Open with…" hand-off.
    async function renderPdfViewer(resource, file) {
        if (!window.pdfjsLib) {
            renderUnsupportedViewer(resource, currentBlobUrl, true);
            return;
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;

        els.workspaceViewer.innerHTML = `
            <div class="pdf-viewer" id="pdfViewer">
                <div class="viewer-toolbar pdf-toolbar">
                    <button type="button" class="icon-button" id="pdfPrevPage" aria-label="Previous page">‹</button>
                    <span id="pdfPageIndicator">Page 1 of ${pdf.numPages}</span>
                    <button type="button" class="icon-button" id="pdfNextPage" aria-label="Next page">›</button>
                    <span class="pdf-toolbar__spacer"></span>
                    <button type="button" class="icon-button" id="pdfZoomOut" aria-label="Zoom out">−</button>
                    <span id="pdfZoomLevel">100%</span>
                    <button type="button" class="icon-button" id="pdfZoomIn" aria-label="Zoom in">+</button>
                </div>
                <div class="pdf-canvas-scroll" id="pdfCanvasScroll">
                    <canvas id="pdfCanvas"></canvas>
                </div>
            </div>`;

        const canvas = document.getElementById("pdfCanvas");
        const scrollArea = document.getElementById("pdfCanvasScroll");
        const pageIndicator = document.getElementById("pdfPageIndicator");
        const zoomLevelLabel = document.getElementById("pdfZoomLevel");
        let pageNumber = 1;
        let zoom = 1;
        let renderTask = null;
        let destroyed = false;

        async function renderPage() {
            if (destroyed) return;
            const page = await pdf.getPage(pageNumber);
            const baseViewport = page.getViewport({ scale: 1 });
            const fitScale = Math.max(0.2, (scrollArea.clientWidth - 24) / baseViewport.width);
            const viewport = page.getViewport({ scale: fitScale * zoom });

            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);

            if (renderTask) renderTask.cancel();
            const context = canvas.getContext("2d");
            renderTask = page.render({ canvasContext: context, viewport });
            try {
                await renderTask.promise;
            } catch (error) {
                if (error?.name !== "RenderingCancelledException") throw error;
            }

            pageIndicator.textContent = `Page ${pageNumber} of ${pdf.numPages}`;
            zoomLevelLabel.textContent = `${Math.round(zoom * 100)}%`;
        }

        document.getElementById("pdfPrevPage").addEventListener("click", () => {
            if (pageNumber > 1) { pageNumber -= 1; renderPage(); }
        });
        document.getElementById("pdfNextPage").addEventListener("click", () => {
            if (pageNumber < pdf.numPages) { pageNumber += 1; renderPage(); }
        });
        document.getElementById("pdfZoomIn").addEventListener("click", () => {
            zoom = Math.min(3, zoom + 0.25); renderPage();
        });
        document.getElementById("pdfZoomOut").addEventListener("click", () => {
            zoom = Math.max(0.5, zoom - 0.25); renderPage();
        });

        await renderPage();

        activeViewerCleanup = () => {
            destroyed = true;
            if (renderTask) renderTask.cancel();
            pdf.destroy?.();
        };
    }

    function closeStudyWorkspace() {
        els.studyWorkspace.classList.remove("workspace-fullscreen");
        els.studyWorkspace.classList.add("hidden");
        els.workspaceViewer.innerHTML = "";
        timer.activeResourceId = null;
        teardownResourceViewer();
    }

    // CSS-only "full screen" mode for the workspace panel (position:
    // fixed covering the viewport). Deliberately NOT the browser
    // Fullscreen API — the focus timer already uses that API for its
    // own distraction-free mode, and layering a second, independent
    // fullscreen request on top of it would create exactly the kind of
    // fullscreenchange ambiguity the integrity system needs to avoid.
    function toggleWorkspaceFullscreen() {
        const isFullscreen = els.studyWorkspace.classList.toggle("workspace-fullscreen");
        if (els.toggleWorkspaceFullscreen) {
            els.toggleWorkspaceFullscreen.textContent = isFullscreen ? "⤡ Exit full screen" : "⤢ Full screen";
        }
    }

    function planResourceTask(id) { const resource = getResource(id); if (!resource) return; openTaskEditor({ title: `Study: ${resource.title}`, description: resource.notes || `Study ${resource.title}`, priority: "medium", dueDate: "", status: "todo", resourceId: id }); }
    function startTaskStudy(id) { const task = state.tasks.find(t => t.id === id); if (!task?.resourceId) return; if (task.status === "todo") task.status = "inProgress"; saveState(); renderTasks(); openStudyResource(task.resourceId, task.id); }

    async function deleteResource(id) {
        const resource = getResource(id); if (!resource || !window.confirm(`Delete "${resource.title}" from your library?`)) return;
        await removeResourceFile(resource.storagePath); state.resources = state.resources.filter(r => r.id !== id); state.tasks.forEach(t => { if (t.resourceId === id) t.resourceId = ""; }); saveState(); renderAll(); showToast("Resource deleted.", "warning");
    }

    function initials(name = "Student") { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "ST"; }
    function applyAvatar(element, profile, large = false) {
        const init = initials(profile.name); element.textContent = profile.photo ? "" : init;
        element.style.backgroundImage = profile.photo ? `url("${profile.photo}")` : "";
        element.classList.toggle("has-photo", Boolean(profile.photo));
        if (large) element.setAttribute("aria-label", profile.photo ? `${profile.name || "Student"} profile picture` : `${init} avatar`);
    }
    function renderProfile() {
        const p = state.profile; const has = Boolean(p.name);
        applyAvatar(els.profileShortcut, p); applyAvatar(els.profileAvatarLarge, p, true);
        els.removeProfilePhoto.classList.toggle("hidden", !p.photo);
        els.profileDisplayName.textContent = has ? p.name : "Create your student profile";
        els.profileDisplayMeta.textContent = has ? [p.course, p.school].filter(Boolean).join(" • ") || p.email : "Add your details to personalise your study experience.";
        els.profileName.value = p.name || ""; els.profileEmail.value = p.email || ""; els.profileSchool.value = p.school || ""; els.profileCourse.value = p.course || ""; els.profileBio.value = p.bio || "";
        els.profileResourceCount.textContent = state.resources.length; els.profileTaskCount.textContent = state.tasks.length; els.profileSessionCount.textContent = state.sessions.length;
    }
    function saveProfile(event) { event.preventDefault(); state.profile = { ...state.profile, name: els.profileName.value.trim(), email: els.profileEmail.value.trim(), school: els.profileSchool.value.trim(), course: els.profileCourse.value.trim(), bio: els.profileBio.value.trim() }; saveState(); renderProfile(); showToast("Student profile saved."); }
    function resizeProfilePhoto(file) {
        return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Could not read image")); reader.onload = () => { const image = new Image(); image.onerror = () => reject(new Error("Invalid image")); image.onload = () => { const max = 640, scale = Math.min(1, max / Math.max(image.width, image.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL("image/jpeg", .86)); }; image.src = reader.result; }; reader.readAsDataURL(file); });
    }
    async function uploadProfilePhoto(event) {
        const file = event.target.files?.[0]; if (!file) return;
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { showToast("Choose a JPG, PNG, or WebP image.", "warning"); return; }
        if (file.size > 5 * 1024 * 1024) { showToast("Profile pictures must be 5 MB or smaller.", "warning"); return; }
        try { state.profile.photo = await resizeProfilePhoto(file); saveState(); renderProfile(); showToast("Profile picture updated."); } catch { showToast("We could not process that image.", "warning"); }
        event.target.value = "";
    }
    function removeProfilePhoto() { if (!state.profile.photo) return; state.profile.photo = ""; saveState(); renderProfile(); showToast("Profile picture removed.", "warning"); }

    function renderAll() {
        renderDashboard();
        renderTasks();
        renderResources();
        renderProfile();
        renderProgress();
        populateSettings();
        updateTimerUI();
    }

    function handleVisibilityChange() {
        if (
            document.hidden &&
            timer.running &&
            timer.mode === "focus" &&
            state.settings.focusTracking
        ) {
            // The student is inside the Study Companion's own resource
            // viewer, not a different tab/app. This is the "internal
            // navigation" case the integrity system is meant to recognise
            // — it does not flag a violation or pause the timer. This is
            // the *only* condition suppressed; every other document.hidden
            // trigger (real tab switch, minimizing, another app) still
            // behaves exactly as before.
            if (isResourceViewerOpen()) return;

            timer.focusViolations += 1;
            timer.automaticallyPausedByBlur = true;
            pauseTimer("Paused: tab hidden");
            updateTimerUI();
        } else if (
            !document.hidden &&
            timer.automaticallyPausedByBlur &&
            timer.mode === "focus"
        ) {
            timer.automaticallyPausedByBlur = false;
            showToast("The focus timer was paused because you left the study tab.", "warning");
        }

        // Best-effort: push any pending changes to the cloud as soon as the
        // tab is backgrounded, in case the user closes it before the
        // debounce timer would otherwise fire.
        if (document.hidden) flushSaveState();
    }

    function handleWindowBlur() {
        if (
            timer.running &&
            timer.mode === "focus" &&
            state.settings.focusTracking &&
            !document.hidden
        ) {
            // Same reasoning as handleVisibilityChange(): opening the
            // in-app resource viewer must not register as the window
            // losing focus to something outside the Study Companion.
            if (isResourceViewerOpen()) return;

            timer.focusViolations += 1;
            timer.automaticallyPausedByBlur = true;
            pauseTimer("Paused: window lost focus");
            updateTimerUI();
            showToast("The focus timer was paused because this window lost focus — this can happen when another window is snapped alongside it.", "warning");
        }
    }

    function handleFullscreenChange() {
        if (
            !document.fullscreenElement &&
            timer.running &&
            timer.mode === "focus" &&
            state.settings.focusTracking
        ) {
            // The resource viewer never requests the browser Fullscreen
            // API (see toggleWorkspaceFullscreen() above), so this
            // listener still only ever fires for the study session's own
            // fullscreen mode exiting. The isResourceViewerOpen() guard is
            // kept here too for defence-in-depth, in case a future viewer
            // type legitimately needs real fullscreen.
            if (isResourceViewerOpen()) return;

            timer.focusViolations += 1;
            timer.automaticallyPausedByBlur = true;
            pauseTimer("Paused: left fullscreen");
            updateTimerUI();
            showToast("The focus timer was paused because you exited fullscreen — this can happen when sharing your screen or splitting the view.", "warning");
        }
    }

    function bindEvents() {
        els.navItems.forEach(item => {
            item.addEventListener("click", () => navigate(item.dataset.section));
        });

        document.querySelectorAll("[data-go-to]").forEach(button => {
            button.addEventListener("click", () => navigate(button.dataset.goTo));
        });

        els.menuButton.addEventListener("click", () => els.sidebar.classList.toggle("open"));

        els.themeToggle.addEventListener("click", () => {
            state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
            saveState();
            applyTheme();
        });

        els.modeTabs.forEach(tab => {
            tab.addEventListener("click", () => setTimerMode(tab.dataset.mode));
        });

        els.startPauseTimer.addEventListener("click", toggleTimer);
        els.resetTimer.addEventListener("click", resetTimer);
        els.skipTimer.addEventListener("click", skipTimer);
        els.confirmPresence.addEventListener("click", confirmPresence);

        els.sessionGoal.addEventListener("input", () => {
            els.goalCount.textContent = els.sessionGoal.value.length;
        });

        els.profileShortcut.addEventListener("click", () => navigate("profile"));
        els.openResourceModal.addEventListener("click", () => {
            els.resourceForm.reset();
            updateFileDropDisplay();
            toggleResourceFields();
            openModal(els.resourceModal);
        });
        els.resourceKind.addEventListener("change", toggleResourceFields);
        els.resourceForm.addEventListener("submit", saveResource);
        els.resourceSearch.addEventListener("input", renderResources);
        els.resourceTypeFilter.addEventListener("change", renderResources);
        els.closeWorkspace.addEventListener("click", closeStudyWorkspace);
        if (els.toggleWorkspaceFullscreen) els.toggleWorkspaceFullscreen.addEventListener("click", toggleWorkspaceFullscreen);
        els.openTutorChat.addEventListener("click", () => openTutorChatFor(timer.activeResourceId));
        els.tutorChatForm.addEventListener("submit", sendTutorChatMessage);
        els.clearTutorChat.addEventListener("click", resetTutorChat);
        els.tutorChatInput.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                els.tutorChatForm.requestSubmit();
            }
        });
        els.profileForm.addEventListener("submit", saveProfile);
        [els.profilePhotoButton, els.changeProfilePhoto].forEach(button => button.addEventListener("click", () => els.profilePhotoInput.click()));
        els.profilePhotoInput.addEventListener("change", uploadProfilePhoto);
        els.removeProfilePhoto.addEventListener("click", removeProfilePhoto);
        els.logoutButton.addEventListener("click", logout);
        bindFileDropEvents();

        els.openTaskModal.addEventListener("click", () => openTaskEditor());
        els.taskForm.addEventListener("submit", saveTask);
        els.taskSearch.addEventListener("input", renderTasks);
        els.priorityFilter.addEventListener("change", renderTasks);

        document.addEventListener("click", event => {
            const closeButton = event.target.closest("[data-close-modal]");
            if (closeButton) {
                closeModal(document.getElementById(closeButton.dataset.closeModal));
            }

            const editButton = event.target.closest("[data-edit-task]");
            if (editButton) {
                const task = state.tasks.find(item => item.id === editButton.dataset.editTask);
                if (task) openTaskEditor(task);
            }

            const deleteButton = event.target.closest("[data-delete-task]");
            if (deleteButton) deleteTask(deleteButton.dataset.deleteTask);

            const moveButton = event.target.closest("[data-move-task]");
            if (moveButton) moveTask(moveButton.dataset.moveTask, moveButton.dataset.nextStatus);

            const studyTaskButton = event.target.closest("[data-study-task]");
            if (studyTaskButton) startTaskStudy(studyTaskButton.dataset.studyTask);

            const openResourceButton = event.target.closest("[data-open-resource]");
            if (openResourceButton) openStudyResource(openResourceButton.dataset.openResource);

            const planResourceButton = event.target.closest("[data-plan-resource]");
            if (planResourceButton) planResourceTask(planResourceButton.dataset.planResource);

            const deleteResourceButton = event.target.closest("[data-delete-resource]");
            if (deleteResourceButton) deleteResource(deleteResourceButton.dataset.deleteResource);

            const reflectionButton = event.target.closest("[data-view-reflection]");
            if (reflectionButton) viewReflection(reflectionButton.dataset.viewReflection);

            const resultsButton = event.target.closest("[data-view-results]");
            if (resultsButton) viewSessionResults(resultsButton.dataset.viewResults);
        });

        document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
            backdrop.addEventListener("mousedown", event => {
                if (event.target !== backdrop) return;
                if ([els.verificationModal, els.reflectionModal].includes(backdrop)) return;
                closeModal(backdrop);
            });
        });

        els.reflectionText.addEventListener("input", validateReflection);
        els.assessmentForm.addEventListener("submit", submitAssessment);
        els.backToReflection.addEventListener("click", backToReflection);
        ["paste", "copy", "cut", "drop"].forEach(eventName => {
            els.reflectionText.addEventListener(eventName, event => {
                event.preventDefault();
                showToast("Copy and paste are disabled for session reflections.", "warning");
            });
        });

        els.reflectionText.addEventListener("contextmenu", event => event.preventDefault());
        els.saveReflection.addEventListener("click", saveReflection);
        els.discardSession.addEventListener("click", discardSession);

        els.clearHistory.addEventListener("click", () => {
            if (!state.sessions.length) return;
            if (!window.confirm("Clear all saved session history?")) return;
            state.sessions = [];
            saveState();
            renderAll();
            showToast("Session history cleared.", "warning");
        });

        els.saveSettings.addEventListener("click", saveSettings);
        els.resetAllData.addEventListener("click", resetAllData);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        document.addEventListener("fullscreenchange", handleFullscreenChange);
        window.addEventListener("blur", handleWindowBlur);

        window.addEventListener("beforeunload", event => {
            if (timer.running && timer.mode === "focus") {
                event.preventDefault();
                event.returnValue = "";
            }
            // Best-effort final sync; may not always complete before unload,
            // but the local cache write inside saveState() already covers
            // this browser, and the debounce keeps most saves well ahead
            // of the user closing the tab.
            flushSaveState();
        });

        document.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                [els.taskModal, els.resourceModal, els.reflectionViewModal].forEach(modal => closeModal(modal));
            }
            if (event.code === "Space" && document.activeElement === document.body) {
                event.preventDefault();
                toggleTimer();
            }
        });
    }

    async function launchApp(user, signupName = "") {
        currentUser = user;
        state = await loadState(user.id);

        state.profile.email = user.email || state.profile.email;
        if (signupName) state.profile.name = signupName;
        else if (user.user_metadata?.full_name) state.profile.name = user.user_metadata.full_name;

        saveState();

        els.authShell.classList.add("hidden");
        els.appShell.classList.remove("hidden");

        const now = new Date();
        els.todayLabel.textContent = new Intl.DateTimeFormat("en-NG", {
            weekday: "long",
            day: "numeric",
            month: "long"
        }).format(now);

        applyTheme();
        populateSettings();
        renderAll();
        setTimerMode("focus", true);
        navigate("dashboard");
    }

    async function initialise() {
        initialiseAuth();
        bindEvents();

        const user = await getCurrentUser();
        if (!user) {
            els.authShell.classList.remove("hidden");
            els.appShell.classList.add("hidden");
            return;
        }

        await launchApp(user);
    }

    initialise();
})();
