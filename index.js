(() => {
    "use strict";

    // 1. Initialize Supabase Connection
    const SUPABASE_URL = "https://bbcrrugbulytupozsfpr.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_xNEdsuqY4FR42LoPekTn6A_Z2Nrm8iJ";

    const createClient =
        window.supabase?.createClient ||
        window.supabaseClient?.createClient ||
        window.supabase;

    const supabase = createClient(
        SUPABASE_URL,
        SUPABASE_ANON_KEY
    );

    window.__debugSupabase = supabase;

    const RESOURCE_BUCKET = "study-resources";
    const STATE_TABLE = "user_state";

    let currentBlobUrl = null;

    function getStorageKey(userId) {
        return userId
            ? `digital_study_companion_state_${userId}`
            : "digital_study_companion_state_guest";
    }

    async function getCurrentUser() {
        try {
            const {
                data: { user }
            } = await supabase.auth.getUser();

            return user;

        } catch (err) {
            console.error(
                "Auth check failed:",
                err
            );

            return null;
        }
    }

    // -------------------------------------------------------------
    // GEMINI SUPABASE EDGE FUNCTION INTEGRATION
    // -------------------------------------------------------------

    const AI_TIMEOUT_MS = 45000;

    function extractAiText(data) {
        if (!data) {
            return "";
        }

        if (typeof data === "string") {
            return data.trim();
        }

        const direct =
            data.text ||
            data.answer ||
            data.response ||
            data.output;

        if (typeof direct === "string") {
            return direct.trim();
        }

        const candidateText =
            data?.candidates?.[0]?.content?.parts
                ?.map(
                    part =>
                        part?.text || ""
                )
                .join("")
                .trim();

        return candidateText || "";
    }

    async function invokeGeminiOnce(
        promptText,
        extra = {}
    ) {
        const invokePromise =
            supabase.functions.invoke(
                "gemini-chat",
                {
                    body: {
                        prompt: promptText,
                        ...extra
                    }
                }
            );

        const timeoutPromise =
            new Promise(
                (_, reject) => {
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "AI request timed out. Please try again."
                                )
                            ),
                        AI_TIMEOUT_MS
                    );
                }
            );

        return Promise.race([
            invokePromise,
            timeoutPromise
        ]);
    }

    async function askGemini(
        promptText,
        extra = {}
    ) {
        const prompt =
            String(
                promptText || ""
            ).trim();

        if (!prompt) {
            throw new Error(
                "The AI request was empty."
            );
        }

        try {
            let {
                data,
                error
            } =
                await invokeGeminiOnce(
                    prompt,
                    extra
                );

            if (error) {
                const status =
                    Number(
                        error?.context?.status ||
                        error?.status ||
                        0
                    );

                if (
                    status === 401 ||
                    status === 403
                ) {
                    await supabase.auth.refreshSession();

                    ({
                        data,
                        error
                    } =
                        await invokeGeminiOnce(
                            prompt,
                            extra
                        ));
                }
            }

            if (error) {
                let detail = "";
                let code = "";
                let retryAfterSeconds = null;

                try {
                    const context =
                        error.context;

                    if (
                        context &&
                        typeof context.json ===
                        "function"
                    ) {
                        const body =
                            await context.json();

                        detail =
                            body?.error ||
                            body?.message ||
                            "";

                        code =
                            body?.code ||
                            "";

                        retryAfterSeconds =
                            typeof body?.retryAfterSeconds ===
                                "number"
                                ? body.retryAfterSeconds
                                : null;
                    }

                } catch (_) { }

                console.error(
                    "Gemini Edge Function Error:",
                    error
                );

                const aiError =
                    new Error(
                        detail ||
                        error.message ||
                        "The AI service could not be reached."
                    );

                aiError.code =
                    code || undefined;

                aiError.retryAfterSeconds =
                    retryAfterSeconds;

                throw aiError;
            }

            if (
                data &&
                typeof data ===
                "object" &&
                data.error
            ) {
                console.error(
                    "Gemini Edge Function returned an error payload:",
                    data.error
                );

                const aiError =
                    new Error(
                        typeof data.error ===
                            "string"
                            ? data.error
                            : "The AI service reported an error."
                    );

                aiError.code =
                    data.code ||
                    undefined;

                aiError.retryAfterSeconds =
                    typeof data.retryAfterSeconds ===
                        "number"
                        ? data.retryAfterSeconds
                        : null;

                throw aiError;
            }

            const text =
                extractAiText(
                    data
                );

            if (!text) {
                console.error(
                    "Unexpected Gemini response:",
                    data
                );

                throw new Error(
                    "The AI service returned an empty response."
                );
            }

            return text;

        } catch (err) {
            console.error(
                "Failed to invoke Gemini Edge Function:",
                err
            );

            throw err instanceof Error
                ? err
                : new Error(
                    "Error connecting to the AI service."
                );
        }
    }

    function describeAiError(error) {
        if (
            error?.code ===
            "quota_exceeded"
        ) {
            const wait =
                Number(
                    error.retryAfterSeconds
                );

            const waitText =
                wait > 0
                    ? ` Please try again in about ${wait < 60
                        ? `${wait}s`
                        : `${Math.ceil(
                            wait / 60
                        )} min`
                    }.`
                    : " Please try again shortly.";

            return `The AI has hit today's usage limit.${waitText}`;
        }

        return (
            error?.message ||
            "The AI service is temporarily unavailable. Please try again."
        );
    }

    // -------------------------------------------------------------
    // STATE
    // -------------------------------------------------------------

    const defaultState = {
        tasks: [],
        sessions: [],
        resources: [],

        profile: {
            name: "",
            email: "",
            school: "",
            course: "",
            department: "",
            level: "",
            bio: "",
            photo: ""
        },

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
    let pendingSignup = null;
    let pendingRecoveryEmail = null;

    let state =
        structuredClone(
            defaultState
        );

    const timer = {
        mode: "focus",

        totalSeconds:
            state.settings.focusMinutes *
            60,

        remainingSeconds:
            state.settings.focusMinutes *
            60,

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
        activeResourceId: null,

        backgroundPrep: null
    };

    const tutorChat = {
        resourceId: null,
        resourceTitle: "",
        context: "",
        history: [],
        sending: false,
        attachment: null
    };

    const TUTOR_ATTACHMENT_TYPES = [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/heic",
        "image/heif",
        "application/pdf"
    ];

    const TUTOR_ATTACHMENT_MAX_BYTES =
        15 * 1024 * 1024;// -------------------------------------------------------------
    // ELEMENT REFERENCES
    // -------------------------------------------------------------

    const els = {
        authShell:
            document.getElementById(
                "authShell"
            ),

        appShell:
            document.getElementById(
                "appShell"
            ),

        loginForm:
            document.getElementById(
                "loginForm"
            ),

        loginEmail:
            document.getElementById(
                "loginEmail"
            ),

        loginPassword:
            document.getElementById(
                "loginPassword"
            ),

        loginError:
            document.getElementById(
                "loginError"
            ),

        rememberMe:
            document.getElementById(
                "rememberMe"
            ),

        signupForm:
            document.getElementById(
                "signupForm"
            ),

        signupName:
            document.getElementById(
                "signupName"
            ),

        signupEmail:
            document.getElementById(
                "signupEmail"
            ),

        signupPassword:
            document.getElementById(
                "signupPassword"
            ),

        signupConfirmPassword:
            document.getElementById(
                "signupConfirmPassword"
            ),

        signupError:
            document.getElementById(
                "signupError"
            ),

        acceptTerms:
            document.getElementById(
                "acceptTerms"
            ),

        passwordStrengthBar:
            document.getElementById(
                "passwordStrengthBar"
            ),

        passwordHint:
            document.getElementById(
                "passwordHint"
            ),

        verifyEmailForm:
            document.getElementById(
                "verifyEmailForm"
            ),

        verifyEmailCode:
            document.getElementById(
                "verifyEmailCode"
            ),

        verifyEmailError:
            document.getElementById(
                "verifyEmailError"
            ),

        verifyEmailAddress:
            document.getElementById(
                "verifyEmailAddress"
            ),

        resendVerificationCode:
            document.getElementById(
                "resendVerificationCode"
            ),

        forgotForm:
            document.getElementById(
                "forgotForm"
            ),

        forgotEmail:
            document.getElementById(
                "forgotEmail"
            ),

        forgotError:
            document.getElementById(
                "forgotError"
            ),

        resetForm:
            document.getElementById(
                "resetForm"
            ),

        resetCode:
            document.getElementById(
                "resetCode"
            ),

        resetPassword:
            document.getElementById(
                "resetPassword"
            ),

        resetConfirmPassword:
            document.getElementById(
                "resetConfirmPassword"
            ),

        resetError:
            document.getElementById(
                "resetError"
            ),

        resetInstruction:
            document.getElementById(
                "resetInstruction"
            ),

        demoResetCode:
            document.getElementById(
                "demoResetCode"
            ),

        logoutButton:
            document.getElementById(
                "logoutButton"
            ),

        navItems:
            document.querySelectorAll(
                ".nav-item"
            ),

        pageSections:
            document.querySelectorAll(
                ".page-section"
            ),

        pageTitle:
            document.getElementById(
                "pageTitle"
            ),

        todayLabel:
            document.getElementById(
                "todayLabel"
            ),

        sidebar:
            document.getElementById(
                "sidebar"
            ),

        menuButton:
            document.getElementById(
                "menuButton"
            ),

        themeToggle:
            document.getElementById(
                "themeToggle"
            ),

        profileShortcut:
            document.getElementById(
                "profileShortcut"
            ),

        openResourceModal:
            document.getElementById(
                "openResourceModal"
            ),

        resourceModal:
            document.getElementById(
                "resourceModal"
            ),

        resourceForm:
            document.getElementById(
                "resourceForm"
            ),

        resourceTitle:
            document.getElementById(
                "resourceTitle"
            ),

        resourceKind:
            document.getElementById(
                "resourceKind"
            ),

        resourceFile:
            document.getElementById(
                "resourceFile"
            ),

        resourceFileDrop:
            document.getElementById(
                "resourceFileDrop"
            ),

        resourceFileIcon:
            document.getElementById(
                "resourceFileIcon"
            ),

        resourceFileLabel:
            document.getElementById(
                "resourceFileLabel"
            ),

        resourceFileName:
            document.getElementById(
                "resourceFileName"
            ),

        resourceFileClear:
            document.getElementById(
                "resourceFileClear"
            ),

        resourceUrl:
            document.getElementById(
                "resourceUrl"
            ),

        resourceNotes:
            document.getElementById(
                "resourceNotes"
            ),

        resourceFileGroup:
            document.getElementById(
                "resourceFileGroup"
            ),

        resourceUrlGroup:
            document.getElementById(
                "resourceUrlGroup"
            ),

        resourceSubmitButton:
            document.getElementById(
                "resourceSubmitButton"
            ),

        resourceGrid:
            document.getElementById(
                "resourceGrid"
            ),

        resourceSearch:
            document.getElementById(
                "resourceSearch"
            ),

        resourceTypeFilter:
            document.getElementById(
                "resourceTypeFilter"
            ),

        documentCount:
            document.getElementById(
                "documentCount"
            ),

        videoCount:
            document.getElementById(
                "videoCount"
            ),

        linkCount:
            document.getElementById(
                "linkCount"
            ),

        studyWorkspace:
            document.getElementById(
                "studyWorkspace"
            ),

        workspaceTitle:
            document.getElementById(
                "workspaceTitle"
            ),

        workspaceViewer:
            document.getElementById(
                "workspaceViewer"
            ),

        closeWorkspace:
            document.getElementById(
                "closeWorkspace"
            ),

        toggleWorkspaceFullscreen:
            document.getElementById(
                "toggleWorkspaceFullscreen"
            ),

        openTutorChat:
            document.getElementById(
                "openTutorChat"
            ),

        tutorChatModal:
            document.getElementById(
                "tutorChatModal"
            ),

        tutorChatTitle:
            document.getElementById(
                "tutorChatTitle"
            ),

        tutorChatResourceNote:
            document.getElementById(
                "tutorChatResourceNote"
            ),

        tutorChatMessages:
            document.getElementById(
                "tutorChatMessages"
            ),

        tutorChatForm:
            document.getElementById(
                "tutorChatForm"
            ),

        tutorChatInput:
            document.getElementById(
                "tutorChatInput"
            ),

        tutorChatSend:
            document.getElementById(
                "tutorChatSend"
            ),

        clearTutorChat:
            document.getElementById(
                "clearTutorChat"
            ),

        tutorChatAttachButton:
            document.getElementById(
                "tutorChatAttachButton"
            ),

        tutorChatFileInput:
            document.getElementById(
                "tutorChatFileInput"
            ),

        tutorChatAttachmentPreview:
            document.getElementById(
                "tutorChatAttachmentPreview"
            ),

        dashboardStreak:
            document.getElementById(
                "dashboardStreak"
            ),

        dashboardHours:
            document.getElementById(
                "dashboardHours"
            ),

        dashboardTasks:
            document.getElementById(
                "dashboardTasks"
            ),

        dashboardSessions:
            document.getElementById(
                "dashboardSessions"
            ),

        dashboardTaskList:
            document.getElementById(
                "dashboardTaskList"
            ),

        weeklyChart:
            document.getElementById(
                "weeklyChart"
            ),

        timerDisplay:
            document.getElementById(
                "timerDisplay"
            ),

        timerRing:
            document.getElementById(
                "timerRing"
            ),

        timerModeLabel:
            document.getElementById(
                "timerModeLabel"
            ),

        timerStatus:
            document.getElementById(
                "timerStatus"
            ),

        startPauseTimer:
            document.getElementById(
                "startPauseTimer"
            ),

        resetTimer:
            document.getElementById(
                "resetTimer"
            ),

        skipTimer:
            document.getElementById(
                "skipTimer"
            ),

        modeTabs:
            document.querySelectorAll(
                ".mode-tab"
            ),

        sessionCycle:
            document.getElementById(
                "sessionCycle"
            ),

        focusViolationCount:
            document.getElementById(
                "focusViolationCount"
            ),

        checksPassedCount:
            document.getElementById(
                "checksPassedCount"
            ),

        sessionTask:
            document.getElementById(
                "sessionTask"
            ),

        sessionGoal:
            document.getElementById(
                "sessionGoal"
            ),

        goalCount:
            document.getElementById(
                "goalCount"
            ),

        openTaskModal:
            document.getElementById(
                "openTaskModal"
            ),

        taskModal:
            document.getElementById(
                "taskModal"
            ),

        taskForm:
            document.getElementById(
                "taskForm"
            ),

        taskModalTitle:
            document.getElementById(
                "taskModalTitle"
            ),

        editingTaskId:
            document.getElementById(
                "editingTaskId"
            ),

        taskTitle:
            document.getElementById(
                "taskTitle"
            ),

        taskDescription:
            document.getElementById(
                "taskDescription"
            ),

        taskPriority:
            document.getElementById(
                "taskPriority"
            ),

        taskDueDate:
            document.getElementById(
                "taskDueDate"
            ),

        taskStatus:
            document.getElementById(
                "taskStatus"
            ),

        taskResource:
            document.getElementById(
                "taskResource"
            ),

        taskSearch:
            document.getElementById(
                "taskSearch"
            ),

        priorityFilter:
            document.getElementById(
                "priorityFilter"
            ),

        todoList:
            document.getElementById(
                "todoList"
            ),

        inProgressList:
            document.getElementById(
                "inProgressList"
            ),

        doneList:
            document.getElementById(
                "doneList"
            ),

        todoCount:
            document.getElementById(
                "todoCount"
            ),

        inProgressCount:
            document.getElementById(
                "inProgressCount"
            ),

        doneCount:
            document.getElementById(
                "doneCount"
            ),

        progressStreak:
            document.getElementById(
                "progressStreak"
            ),

        longestStreak:
            document.getElementById(
                "longestStreak"
            ),

        progressTotalTime:
            document.getElementById(
                "progressTotalTime"
            ),

        completionRate:
            document.getElementById(
                "completionRate"
            ),

        progressChart:
            document.getElementById(
                "progressChart"
            ),

        goalRing:
            document.getElementById(
                "goalRing"
            ),

        weeklyGoalPercent:
            document.getElementById(
                "weeklyGoalPercent"
            ),

        weeklyGoalCaption:
            document.getElementById(
                "weeklyGoalCaption"
            ),

        historyBody:
            document.getElementById(
                "historyBody"
            ),

        clearHistory:
            document.getElementById(
                "clearHistory"
            ),

        focusMinutesSetting:
            document.getElementById(
                "focusMinutesSetting"
            ),

        shortBreakSetting:
            document.getElementById(
                "shortBreakSetting"
            ),

        longBreakSetting:
            document.getElementById(
                "longBreakSetting"
            ),

        cyclesSetting:
            document.getElementById(
                "cyclesSetting"
            ),

        weeklyGoalSetting:
            document.getElementById(
                "weeklyGoalSetting"
            ),

        focusTrackingSetting:
            document.getElementById(
                "focusTrackingSetting"
            ),

        verificationSetting:
            document.getElementById(
                "verificationSetting"
            ),

        soundSetting:
            document.getElementById(
                "soundSetting"
            ),

        saveSettings:
            document.getElementById(
                "saveSettings"
            ),

        resetAllData:
            document.getElementById(
                "resetAllData"
            ),

        migrateToB2:
            document.getElementById(
                "migrateToB2"
            ),

        profileForm:
            document.getElementById(
                "profileForm"
            ),

        profileName:
            document.getElementById(
                "profileName"
            ),

        profileEmail:
            document.getElementById(
                "profileEmail"
            ),

        profileSchool:
            document.getElementById(
                "profileSchool"
            ),

        profileCourse:
            document.getElementById(
                "profileCourse"
            ),

        profileDepartment:
            document.getElementById(
                "profileDepartment"
            ),

        profileLevel:
            document.getElementById(
                "profileLevel"
            ),

        profileBio:
            document.getElementById(
                "profileBio"
            ),

        profileAvatarLarge:
            document.getElementById(
                "profileAvatarLarge"
            ),

        profileDisplayName:
            document.getElementById(
                "profileDisplayName"
            ),

        profileDisplayMeta:
            document.getElementById(
                "profileDisplayMeta"
            ),

        profileResourceCount:
            document.getElementById(
                "profileResourceCount"
            ),

        profileTaskCount:
            document.getElementById(
                "profileTaskCount"
            ),

        profileSessionCount:
            document.getElementById(
                "profileSessionCount"
            ),

        profilePhotoInput:
            document.getElementById(
                "profilePhotoInput"
            ),

        profilePhotoButton:
            document.getElementById(
                "profilePhotoButton"
            ),

        changeProfilePhoto:
            document.getElementById(
                "changeProfilePhoto"
            ),

        removeProfilePhoto:
            document.getElementById(
                "removeProfilePhoto"
            ),

        verificationModal:
            document.getElementById(
                "verificationModal"
            ),

        verificationCountdown:
            document.getElementById(
                "verificationCountdown"
            ),

        confirmPresence:
            document.getElementById(
                "confirmPresence"
            ),

        reflectionModal:
            document.getElementById(
                "reflectionModal"
            ),

        reflectionText:
            document.getElementById(
                "reflectionText"
            ),

        reflectionCount:
            document.getElementById(
                "reflectionCount"
            ),

        reflectionValidation:
            document.getElementById(
                "reflectionValidation"
            ),

        reflectionResourceNote:
            document.getElementById(
                "reflectionResourceNote"
            ),

        reflectionAlignment:
            document.getElementById(
                "reflectionAlignment"
            ),

        saveReflection:
            document.getElementById(
                "saveReflection"
            ),

        discardSession:
            document.getElementById(
                "discardSession"
            ),

        reflectionViewModal:
            document.getElementById(
                "reflectionViewModal"
            ),

        reflectionViewTitle:
            document.getElementById(
                "reflectionViewTitle"
            ),

        reflectionViewText:
            document.getElementById(
                "reflectionViewText"
            ),

        assessmentModal:
            document.getElementById(
                "assessmentModal"
            ),

        assessmentForm:
            document.getElementById(
                "assessmentForm"
            ),

        assessmentSummaryStatus:
            document.getElementById(
                "assessmentSummaryStatus"
            ),

        objectiveQuestions:
            document.getElementById(
                "objectiveQuestions"
            ),

        assessmentValidation:
            document.getElementById(
                "assessmentValidation"
            ),

        backToReflection:
            document.getElementById(
                "backToReflection"
            ),

        toastContainer:
            document.getElementById(
                "toastContainer"
            )
    };

    // -------------------------------------------------------------
    // AUTHENTICATION
    // -------------------------------------------------------------

    function validEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            email
        );
    }

    function passwordScore(password) {
        if (!password) {
            return 0;
        }

        return [
            password.length >= 8,
            /[a-z]/.test(password),
            /[A-Z]/.test(password),
            /\d/.test(password),
            /[^A-Za-z0-9]/.test(password)
        ].filter(Boolean).length;
    }

    function validPassword(password) {
        return (
            password.length >= 8 &&
            /[a-z]/.test(password) &&
            /[A-Z]/.test(password) &&
            /\d/.test(password)
        );
    }

    function showAuthView(id) {
        document
            .querySelectorAll(
                ".auth-view"
            )
            .forEach(
                view =>
                    view.classList.toggle(
                        "active",
                        view.id === id
                    )
            );

        document
            .querySelectorAll(
                ".form-error"
            )
            .forEach(
                error => {
                    error.textContent = "";
                }
            );
    }

    async function handleSignup(event) {
        event.preventDefault();

        const name =
            els.signupName.value.trim();

        const email =
            els.signupEmail.value
                .trim()
                .toLowerCase();

        const password =
            els.signupPassword.value;

        const confirm =
            els.signupConfirmPassword.value;

        if (name.length < 2) {
            els.signupError.textContent =
                "Please enter your full name.";

            return;
        }

        if (!validEmail(email)) {
            els.signupError.textContent =
                "Enter a valid email address.";

            return;
        }

        if (!validPassword(password)) {
            els.signupError.textContent =
                "Use at least 8 characters with uppercase, lowercase, and a number.";

            return;
        }

        if (password !== confirm) {
            els.signupError.textContent =
                "The passwords do not match.";

            return;
        }

        if (!els.acceptTerms.checked) {
            els.signupError.textContent =
                "Please accept the Terms and Privacy Notice.";

            return;
        }

        const {
            data,
            error
        } =
            await supabase.auth.signUp({
                email,
                password,

                options: {
                    data: {
                        full_name: name
                    }
                }
            });

        if (error) {
            els.signupError.textContent =
                error.message;

            return;
        }

        if (data.session) {
            await supabase.auth.signOut();
        }

        pendingSignup = {
            email,
            name
        };

        els.verifyEmailAddress.textContent =
            email;

        els.verifyEmailError.textContent =
            "";

        els.verifyEmailForm.reset();

        showAuthView(
            "verifyEmailView"
        );

        showToast(
            "Enter the 6-digit code we emailed you to finish creating your account.",
            "warning"
        );
    }

    async function handleVerifySignupOtp(
        event
    ) {
        event.preventDefault();

        if (!pendingSignup) {
            els.verifyEmailError.textContent =
                "Start the signup again to request a new code.";

            return;
        }

        const code =
            els.verifyEmailCode.value.trim();

        if (!/^\d{6}$/.test(code)) {
            els.verifyEmailError.textContent =
                "Enter the 6-digit code from your email.";

            return;
        }

        const {
            data,
            error
        } =
            await supabase.auth.verifyOtp({
                email:
                    pendingSignup.email,

                token:
                    code,

                type:
                    "email"
            });

        if (error) {
            els.verifyEmailError.textContent =
                error.message ||
                "That code is invalid or expired. Request a new one below.";

            return;
        }

        const name =
            pendingSignup.name;

        pendingSignup =
            null;

        showToast(
            "Email verified — account created successfully!"
        );

        await launchApp(
            data.user,
            name
        );
    }

    async function handleResendVerificationCode() {
        if (!pendingSignup) {
            els.verifyEmailError.textContent =
                "Start the signup again to request a new code.";

            return;
        }

        const {
            error
        } =
            await supabase.auth.resend({
                type:
                    "signup",

                email:
                    pendingSignup.email
            });

        if (error) {
            els.verifyEmailError.textContent =
                error.message;

        } else {
            els.verifyEmailError.textContent =
                "";

            showToast(
                "A new code is on its way to your email."
            );
        }
    }

    async function handleLogin(event) {
        event.preventDefault();

        const email =
            els.loginEmail.value
                .trim()
                .toLowerCase();

        const password =
            els.loginPassword.value;

        if (!validEmail(email)) {
            els.loginError.textContent =
                "Enter a valid email address.";

            return;
        }

        const {
            data,
            error
        } =
            await supabase.auth.signInWithPassword({
                email,
                password
            });

        if (error) {
            els.loginError.textContent =
                "Incorrect email or password. Please try again.";

        } else {
            showToast(
                "Welcome back!"
            );

            await launchApp(
                data.user
            );
        }
    }

    async function handleForgot(event) {
        event.preventDefault();

        const email =
            els.forgotEmail.value
                .trim()
                .toLowerCase();

        if (!validEmail(email)) {
            els.forgotError.textContent =
                "Enter a valid email address.";

            return;
        }

        els.forgotError.textContent =
            "";

        const {
            error
        } =
            await supabase.auth.resetPasswordForEmail(
                email
            );

        if (error) {
            els.forgotError.textContent =
                error.message;

            return;
        }

        pendingRecoveryEmail =
            email;

        els.resetInstruction.textContent =
            `Enter the 6-digit code sent to ${email}, then choose a new password.`;

        if (els.demoResetCode) {
            els.demoResetCode.textContent =
                "";

            els.demoResetCode.classList.add(
                "hidden"
            );
        }

        els.resetForm.reset();

        showAuthView(
            "resetView"
        );

        showToast(
            "A password reset code has been sent to your email."
        );
    }

    async function handleReset(event) {
        event.preventDefault();

        if (!pendingRecoveryEmail) {
            els.resetError.textContent =
                "Request a new password reset code first.";

            return;
        }

        const code =
            els.resetCode.value.trim();

        const password =
            els.resetPassword.value;

        const confirm =
            els.resetConfirmPassword.value;

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
            els.resetError.textContent =
                "The passwords do not match.";

            return;
        }

        els.resetError.textContent =
            "";

        const {
            error: verificationError
        } =
            await supabase.auth.verifyOtp({
                email:
                    pendingRecoveryEmail,

                token:
                    code,

                type:
                    "recovery"
            });

        if (verificationError) {
            els.resetError.textContent =
                verificationError.message ||
                "The reset code is invalid or has expired.";

            return;
        }

        const {
            error: updateError
        } =
            await supabase.auth.updateUser({
                password
            });

        if (updateError) {
            els.resetError.textContent =
                updateError.message;

            return;
        }

        pendingRecoveryEmail =
            null;

        els.resetForm.reset();

        await supabase.auth.signOut();

        showToast(
            "Password updated successfully!"
        );

        showAuthView(
            "resetSuccessView"
        );
    }

    async function logout() {
        if (
            timer.running &&
            !window.confirm(
                "A focus session is running. Log out anyway?"
            )
        ) {
            return;
        }

        revokeBlobUrl();

        await flushSaveState();

        await supabase.auth.signOut();

        currentUser =
            null;

        state =
            structuredClone(
                defaultState
            );

        els.appShell.classList.add(
            "hidden"
        );

        els.authShell.classList.remove(
            "hidden"
        );

        showAuthView(
            "loginView"
        );

        showToast(
            "Logged out.",
            "warning"
        );
    }

    function initialiseAuth() {
        document
            .querySelectorAll(
                "[data-auth-view]"
            )
            .forEach(
                button =>
                    button.addEventListener(
                        "click",
                        () =>
                            showAuthView(
                                button.dataset.authView
                            )
                    )
            );

        document
            .querySelectorAll(
                "[data-password-toggle]"
            )
            .forEach(
                button =>
                    button.addEventListener(
                        "click",
                        () => {
                            const input =
                                document.getElementById(
                                    button.dataset.passwordToggle
                                );

                            input.type =
                                input.type === "password"
                                    ? "text"
                                    : "password";

                            button.textContent =
                                input.type === "password"
                                    ? "Show"
                                    : "Hide";
                        }
                    )
            );

        els.signupPassword.addEventListener(
            "input",
            () => {
                const val =
                    els.signupPassword.value;

                if (!val) {
                    els.passwordStrengthBar.style.width =
                        "0%";

                    els.passwordHint.textContent =
                        "";

                    return;
                }

                const score =
                    passwordScore(
                        val
                    );

                els.passwordStrengthBar.style.width =
                    `${score * 20}%`;

                els.passwordHint.textContent =
                    score <= 2
                        ? "Weak password"
                        : score <= 4
                            ? "Good password"
                            : "Strong password";
            }
        );

        els.loginForm.addEventListener(
            "submit",
            handleLogin
        );

        els.signupForm.addEventListener(
            "submit",
            handleSignup
        );

        if (els.verifyEmailForm) {
            els.verifyEmailForm.addEventListener(
                "submit",
                handleVerifySignupOtp
            );
        }

        if (els.resendVerificationCode) {
            els.resendVerificationCode.addEventListener(
                "click",
                handleResendVerificationCode
            );
        }

        if (els.forgotForm) {
            els.forgotForm.addEventListener(
                "submit",
                handleForgot
            );
        }

        if (els.resetForm) {
            els.resetForm.addEventListener(
                "submit",
                handleReset
            );
        }
    }

    // -------------------------------------------------------------
    // CLOUD STATE SYNC
    // -------------------------------------------------------------

    function mergeWithDefaults(stored) {
        if (!stored) {
            return structuredClone(
                defaultState
            );
        }

        return {
            tasks:
                Array.isArray(
                    stored.tasks
                )
                    ? stored.tasks
                    : [],

            sessions:
                Array.isArray(
                    stored.sessions
                )
                    ? stored.sessions
                    : [],

            resources:
                Array.isArray(
                    stored.resources
                )
                    ? stored.resources
                    : [],

            profile: {
                ...defaultState.profile,
                ...(stored.profile || {})
            },

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
            const stored =
                JSON.parse(
                    localStorage.getItem(
                        getStorageKey(
                            userId
                        )
                    )
                );

            return stored
                ? mergeWithDefaults(
                    stored
                )
                : null;

        } catch (error) {
            console.warn(
                "Could not read local cache.",
                error
            );

            return null;
        }
    }

    function writeLocalCache(
        userId,
        value
    ) {
        try {
            localStorage.setItem(
                getStorageKey(
                    userId
                ),

                JSON.stringify(
                    value
                )
            );

        } catch (error) {
            console.warn(
                "Could not write local cache.",
                error
            );
        }
    }

    async function loadState(userId) {
        try {
            const {
                data,
                error
            } =
                await supabase
                    .from(
                        STATE_TABLE
                    )
                    .select(
                        "data"
                    )
                    .eq(
                        "user_id",
                        userId
                    )
                    .maybeSingle();

            if (error) {
                throw error;
            }

            if (
                data &&
                data.data
            ) {
                const merged =
                    mergeWithDefaults(
                        data.data
                    );

                writeLocalCache(
                    userId,
                    merged
                );

                return merged;
            }

            const cached =
                readLocalCache(
                    userId
                );

            return (
                cached ||
                structuredClone(
                    defaultState
                )
            );

        } catch (error) {
            console.warn(
                "Could not load state from the cloud — using local cache instead.",
                error
            );

            showToast(
                "Could not reach the cloud. Showing your last saved data on this device.",
                "warning"
            );

            return (
                readLocalCache(
                    userId
                ) ||
                structuredClone(
                    defaultState
                )
            );
        }
    }

    let saveStateTimeoutId =
        null;

    let saveStateInFlight =
        false;

    let saveStateQueuedAgain =
        false;

    async function persistStateNow() {
        if (!currentUser) {
            return;
        }

        if (saveStateInFlight) {
            saveStateQueuedAgain =
                true;

            return;
        }

        saveStateInFlight =
            true;

        try {
            const {
                error
            } =
                await supabase
                    .from(
                        STATE_TABLE
                    )
                    .upsert(
                        {
                            user_id:
                                currentUser.id,

                            data:
                                state,

                            updated_at:
                                new Date().toISOString()
                        },

                        {
                            onConflict:
                                "user_id"
                        }
                    );

            if (error) {
                console.error(
                    "Could not save state to the cloud.",
                    error
                );

                showToast(
                    "Could not sync your latest changes to the cloud. They're saved on this device for now.",
                    "error"
                );
            }

        } catch (error) {
            console.error(
                "Could not save state to the cloud.",
                error
            );

            showToast(
                "Could not sync your latest changes to the cloud. They're saved on this device for now.",
                "error"
            );

        } finally {
            saveStateInFlight =
                false;

            if (saveStateQueuedAgain) {
                saveStateQueuedAgain =
                    false;

                persistStateNow();
            }
        }
    }

    function saveState() {
        if (!currentUser) {
            return;
        }

        writeLocalCache(
            currentUser.id,
            state
        );

        if (saveStateTimeoutId) {
            clearTimeout(
                saveStateTimeoutId
            );
        }

        saveStateTimeoutId =
            setTimeout(
                persistStateNow,
                500
            );
    }

    async function flushSaveState() {
        if (saveStateTimeoutId) {
            clearTimeout(
                saveStateTimeoutId
            );

            saveStateTimeoutId =
                null;
        }

        await persistStateNow();
    }
    // -------------------------------------------------------------
    // GENERAL UTILITIES
    // -------------------------------------------------------------

    function escapeHtml(value = "") {
        return String(value)
            .replaceAll(
                "&",
                "&amp;"
            )
            .replaceAll(
                "<",
                "&lt;"
            )
            .replaceAll(
                ">",
                "&gt;"
            )
            .replaceAll(
                '"',
                "&quot;"
            )
            .replaceAll(
                "'",
                "&#039;"
            );
    }

    function renderKatex(
        expr,
        displayMode
    ) {
        const fallback = () =>
            escapeHtml(
                displayMode
                    ? `$$${expr}$$`
                    : `$${expr}$`
            );

        if (!window.katex) {
            return fallback();
        }

        try {
            return window.katex.renderToString(
                expr.trim(),
                {
                    throwOnError:
                        false,

                    displayMode
                }
            );

        } catch (error) {
            console.warn(
                "KaTeX render failed.",
                error
            );

            return fallback();
        }
    }
    function renderMarkdown(text = "") {
        let source =
            String(text);
        const mathBlocks = [];
        const mathInline = [];

        source =
            source.replace(
                /\$\$([\s\S]+?)\$\$/g,
                (
                    _match,
                    expr
                ) => {
                    mathBlocks.push(
                        renderKatex(
                            expr,
                            true
                        )
                    );
                    return `\uE000B${mathBlocks.length - 1}\uE000`;
                }
            );

        source =
            source.replace(
                /\$([^\$\n]+?)\$/g,
                (
                    _match,
                    expr
                ) => {
                    mathInline.push(
                        renderKatex(
                            expr,
                            false
                        )
                    );
                    return `\uE000I${mathInline.length - 1}\uE000`;
                }
            );

        const escaped =
            escapeHtml(
                source
            );

        const lines =
            escaped.split(
                "\n"
            );

        const htmlBlocks = [];
        let listBuffer = [];
        let listType = null;
        let olCounter = 0;

        function flushList() {
            if (!listBuffer.length) {
                return;
            }

            const items =
                listBuffer
                    .map(
                        item =>
                            `<li>${item}</li>`
                    )
                    .join("");

            const startAttr =
                listType === "ol"
                    ? ` start="${olCounter - listBuffer.length + 1}"`
                    : "";

            htmlBlocks.push(
                `<${listType}${startAttr}>${items}</${listType}>`
            );

            listBuffer = [];
            listType = null;
        }

        function inline(str) {
            return str
                .replace(
                    /\*\*(.+?)\*\*/g,
                    "<strong>$1</strong>"
                )
                .replace(
                    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
                    "<em>$1</em>"
                )
                .replace(
                    /`([^`]+)`/g,
                    "<code>$1</code>"
                );
        }

        for (
            const rawLine of lines
        ) {
            const line =
                rawLine.trim();

            if (!line) {
                flushList();
                continue;
            }

            const dividerMatch =
                /^([-*_])\1{2,}$/.test(
                    line
                );

            if (dividerMatch) {
                flushList();
                olCounter = 0;

                htmlBlocks.push(
                    "<hr>"
                );

                continue;
            }

            const headerMatch =
                line.match(
                    /^(#{1,6})\s+(.*)$/
                );

            if (headerMatch) {
                flushList();
                olCounter = 0;

                const level =
                    Math.min(
                        headerMatch[1].length +
                        2,
                        6
                    );

                htmlBlocks.push(
                    `<h${level}>${inline(
                        headerMatch[2]
                    )}</h${level}>`
                );

                continue;
            }

            const quoteMatch =
                line.match(
                    /^&gt;\s?(.*)$/
                );

            if (quoteMatch) {
                flushList();

                htmlBlocks.push(
                    `<blockquote>${inline(
                        quoteMatch[1]
                    )}</blockquote>`
                );

                continue;
            }

            const bulletMatch =
                line.match(
                    /^[-*]\s+(.*)$/
                );

            if (bulletMatch) {
                if (
                    listType !==
                    "ul"
                ) {
                    flushList();
                    listType =
                        "ul";
                }

                listBuffer.push(
                    inline(
                        bulletMatch[1]
                    )
                );

                continue;
            }

            const numberedMatch =
                line.match(
                    /^\d+[.)]\s+(.*)$/
                );

            if (numberedMatch) {
                if (
                    listType !==
                    "ol"
                ) {
                    flushList();
                    listType =
                        "ol";
                }

                listBuffer.push(
                    inline(
                        numberedMatch[1]
                    )
                );

                olCounter += 1;
                continue;
            }

            flushList();

            htmlBlocks.push(
                `<p>${inline(
                    line
                )}</p>`
            );
        }

        flushList();

        let result =
            htmlBlocks.join("");

        result =
            result.replace(
                /\uE000B(\d+)\uE000/g,
                (
                    _match,
                    i
                ) =>
                    mathBlocks[
                    Number(i)
                    ]
            );

        result =
            result.replace(
                /\uE000I(\d+)\uE000/g,
                (
                    _match,
                    i
                ) =>
                    mathInline[
                    Number(i)
                    ]
            );

        return result;
    }

    const TOAST_LIFETIME_MS =
        3600;

    const MAX_VISIBLE_TOASTS =
        3;

    function showToast(
        message,
        type = "success"
    ) {
        const container =
            els.toastContainer;

        const existing =
            [
                ...container.children
            ].find(
                toast =>
                    toast.dataset.message ===
                    message &&
                    toast.dataset.type ===
                    type
            );

        if (existing) {
            clearTimeout(
                Number(
                    existing.dataset.timeoutId
                )
            );

            existing.dataset.timeoutId =
                scheduleToastRemoval(
                    existing
                );

            return;
        }

        const current =
            [
                ...container.children
            ];

        while (
            current.length >=
            MAX_VISIBLE_TOASTS
        ) {
            const oldest =
                current.shift();

            clearTimeout(
                Number(
                    oldest.dataset.timeoutId
                )
            );

            oldest.remove();
        }

        const toast =
            document.createElement(
                "div"
            );

        toast.className =
            `toast ${type}`;

        toast.textContent =
            message;

        toast.dataset.message =
            message;

        toast.dataset.type =
            type;

        container.appendChild(
            toast
        );

        toast.dataset.timeoutId =
            scheduleToastRemoval(
                toast
            );
    }

    function scheduleToastRemoval(
        toast
    ) {
        return setTimeout(
            () =>
                removeToast(
                    toast
                ),
            TOAST_LIFETIME_MS
        );
    }

    function removeToast(toast) {
        if (
            !toast ||
            toast.dataset.removing
        ) {
            return;
        }

        toast.dataset.removing =
            "true";

        clearTimeout(
            Number(
                toast.dataset.timeoutId
            )
        );

        toast.classList.add(
            "toast--out"
        );

        toast.addEventListener(
            "animationend",
            () =>
                toast.remove(),
            {
                once: true
            }
        );

        setTimeout(
            () =>
                toast.remove(),
            300
        );
    }

    function openModal(modal) {
        modal.classList.remove(
            "hidden"
        );

        document.body.style.overflow =
            "hidden";
    }

    function closeModal(modal) {
        modal.classList.add(
            "hidden"
        );

        if (
            !document.querySelector(
                ".modal-backdrop:not(.hidden)"
            )
        ) {
            document.body.style.overflow =
                "";
        }
    }

    function navigate(section) {
        const titleMap = {
            dashboard:
                "Dashboard",

            library:
                "Study Library",

            timer:
                "Study Timer",

            tasks:
                "Task Board",

            progress:
                "Progress",

            profile:
                "Student Profile",

            settings:
                "Settings"
        };

        els.navItems.forEach(
            item => {
                item.classList.toggle(
                    "active",
                    item.dataset.section ===
                    section
                );
            }
        );

        els.pageSections.forEach(
            page => {
                page.classList.toggle(
                    "active",
                    page.id ===
                    `${section}Section`
                );
            }
        );

        els.pageTitle.textContent =
            titleMap[section];

        els.sidebar.classList.remove(
            "open"
        );

        if (
            section ===
            "progress"
        ) {
            renderProgress();
        }

        if (
            section ===
            "tasks"
        ) {
            renderTasks();
        }

        if (
            section ===
            "library"
        ) {
            renderResources();
        }

        if (
            section ===
            "profile"
        ) {
            renderProfile();
        }

        if (
            section ===
            "dashboard"
        ) {
            renderDashboard();
        }
    }

    function applyTheme() {
        document.body.classList.toggle(
            "dark",
            state.settings.theme ===
            "dark"
        );

        els.themeToggle.textContent =
            state.settings.theme ===
                "dark"
                ? "☀"
                : "☾";
    }

    function formatMinutes(
        totalMinutes
    ) {
        const minutes =
            Math.max(
                0,
                Math.round(
                    totalMinutes
                )
            );

        const hours =
            Math.floor(
                minutes /
                60
            );

        const remainder =
            minutes %
            60;

        return `${hours}h ${remainder}m`;
    }

    function formatDate(
        dateStringOrTimestamp
    ) {
        const date =
            new Date(
                dateStringOrTimestamp
            );

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return "No date";
        }

        return new Intl.DateTimeFormat(
            "en-NG",
            {
                day:
                    "numeric",

                month:
                    "short",

                year:
                    "numeric"
            }
        ).format(
            date
        );
    }

    function getDateKey(
        date = new Date()
    ) {
        const local =
            new Date(
                date.getFullYear(),
                date.getMonth(),
                date.getDate()
            );

        return [
            local.getFullYear(),

            String(
                local.getMonth() +
                1
            ).padStart(
                2,
                "0"
            ),

            String(
                local.getDate()
            ).padStart(
                2,
                "0"
            )
        ].join("-");
    }

    function getLastSevenDays() {
        const result = [];

        for (
            let i = 6;
            i >= 0;
            i -= 1
        ) {
            const date =
                new Date();

            date.setHours(
                0,
                0,
                0,
                0
            );

            date.setDate(
                date.getDate() -
                i
            );

            result.push(
                date
            );
        }

        return result;
    }

    function calculateStreaks() {
        const uniqueDays = [
            ...new Set(
                state.sessions.map(
                    session =>
                        getDateKey(
                            new Date(
                                session.completedAt
                            )
                        )
                )
            )
        ].sort();

        if (!uniqueDays.length) {
            return {
                current: 0,
                longest: 0
            };
        }

        let longest = 1;
        let running = 1;

        for (
            let i = 1;
            i <
            uniqueDays.length;
            i += 1
        ) {
            const previous =
                new Date(
                    `${uniqueDays[i - 1]}T00:00:00`
                );

            const current =
                new Date(
                    `${uniqueDays[i]}T00:00:00`
                );

            const diffDays =
                Math.round(
                    (
                        current -
                        previous
                    ) /
                    86400000
                );

            if (
                diffDays === 1
            ) {
                running += 1;

                longest =
                    Math.max(
                        longest,
                        running
                    );

            } else {
                running = 1;
            }
        }

        const latest =
            new Date(
                `${uniqueDays.at(-1)}T00:00:00`
            );

        const today =
            new Date();

        today.setHours(
            0,
            0,
            0,
            0
        );

        const yesterday =
            new Date(
                today
            );

        yesterday.setDate(
            today.getDate() -
            1
        );

        let current = 0;

        if (
            latest.getTime() ===
            today.getTime() ||
            latest.getTime() ===
            yesterday.getTime()
        ) {
            current = 1;

            for (
                let i =
                    uniqueDays.length -
                    1;
                i > 0;
                i -= 1
            ) {
                const newer =
                    new Date(
                        `${uniqueDays[i]}T00:00:00`
                    );

                const older =
                    new Date(
                        `${uniqueDays[i - 1]}T00:00:00`
                    );

                if (
                    Math.round(
                        (
                            newer -
                            older
                        ) /
                        86400000
                    ) === 1
                ) {
                    current += 1;

                } else {
                    break;
                }
            }
        }

        return {
            current,
            longest
        };
    }

    function getWeeklyMinutes() {
        const start =
            new Date();

        start.setHours(
            0,
            0,
            0,
            0
        );

        const day =
            start.getDay();

        const distanceFromMonday =
            day === 0
                ? 6
                : day - 1;

        start.setDate(
            start.getDate() -
            distanceFromMonday
        );

        return state.sessions
            .filter(
                session =>
                    new Date(
                        session.completedAt
                    ) >=
                    start
            )
            .reduce(
                (
                    sum,
                    session
                ) =>
                    sum +
                    session.durationMinutes,
                0
            );
    }

    function renderBarChart(
        container,
        days,
        large = false
    ) {
        const data =
            days.map(
                day => {
                    const key =
                        getDateKey(
                            day
                        );

                    const minutes =
                        state.sessions
                            .filter(
                                session =>
                                    getDateKey(
                                        new Date(
                                            session.completedAt
                                        )
                                    ) ===
                                    key
                            )
                            .reduce(
                                (
                                    sum,
                                    session
                                ) =>
                                    sum +
                                    session.durationMinutes,
                                0
                            );

                    return {
                        day,
                        minutes
                    };
                }
            );

        const max =
            Math.max(
                ...data.map(
                    item =>
                        item.minutes
                ),
                30
            );

        const maxHeight =
            large
                ? 230
                : 150;

        container.innerHTML =
            data.map(
                item => {
                    const height =
                        item.minutes ===
                            0
                            ? 6
                            : Math.max(
                                12,
                                (
                                    item.minutes /
                                    max
                                ) *
                                maxHeight
                            );

                    const label =
                        new Intl.DateTimeFormat(
                            "en-NG",
                            {
                                weekday:
                                    "short"
                            }
                        ).format(
                            item.day
                        );

                    return `
<div
class="chart-bar-group"
title="${item.minutes} study minutes"
>
<span class="chart-value">
${item.minutes}m
</span>

<div
class="chart-bar"
style="height:${height}px"
></div>

<span class="chart-label">
${label}
</span>
</div>
`;
                }
            ).join("");
    }

    function renderDashboard() {
        const totalMinutes =
            state.sessions.reduce(
                (
                    sum,
                    session
                ) =>
                    sum +
                    session.durationMinutes,
                0
            );

        const completedTasks =
            state.tasks.filter(
                task =>
                    task.status ===
                    "done"
            ).length;

        const streaks =
            calculateStreaks();

        els.dashboardStreak.textContent =
            streaks.current;

        els.dashboardHours.textContent =
            formatMinutes(
                totalMinutes
            );

        els.dashboardTasks.textContent =
            completedTasks;

        els.dashboardSessions.textContent =
            state.sessions.length;

        const priorityOrder = {
            high: 0,
            medium: 1,
            low: 2
        };

        const activeTasks =
            state.tasks
                .filter(
                    task =>
                        task.status !==
                        "done"
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        priorityOrder[
                        a.priority
                        ] -
                        priorityOrder[
                        b.priority
                        ]
                )
                .slice(
                    0,
                    5
                );

        els.dashboardTaskList.innerHTML =
            activeTasks.length
                ? activeTasks
                    .map(
                        task => `
<div class="compact-task">
<span
class="compact-task__status"
style="background:${task.priority === "high"
                                ? "var(--danger)"
                                : task.priority === "medium"
                                    ? "var(--warning)"
                                    : "var(--success)"
                            }"
></span>

<div class="compact-task__content">
<strong>
${escapeHtml(
                                task.title
                            )}
</strong>

<small>
${task.dueDate
                                ? `Due ${formatDate(
                                    task.dueDate
                                )}`
                                : "No due date"
                            }
</small>
</div>

<span class="priority-badge priority-${task.priority}">
${task.priority}
</span>
</div>
`
                    )
                    .join("")
                : `
<div class="empty-state">
No active tasks. Add a task and give your next session a clear target.
</div>
`;

        renderBarChart(
            els.weeklyChart,
            getLastSevenDays()
        );
    }

    function renderSessionTaskOptions() {
        const currentValue =
            els.sessionTask.value;

        const options =
            state.tasks
                .filter(
                    task =>
                        task.status !==
                        "done"
                )
                .map(
                    task =>
                        `<option value="${task.id}">${escapeHtml(
                            task.title
                        )}</option>`
                )
                .join("");

        els.sessionTask.innerHTML =
            `<option value="">General study session</option>${options}`;

        if (
            [
                ...els.sessionTask.options
            ].some(
                option =>
                    option.value ===
                    currentValue
            )
        ) {
            els.sessionTask.value =
                currentValue;
        }
    }

    function renderTasks() {
        const query =
            els.taskSearch.value
                .trim()
                .toLowerCase();

        const priority =
            els.priorityFilter.value;

        const filtered =
            state.tasks.filter(
                task => {
                    const matchesQuery =
                        !query ||
                        task.title
                            .toLowerCase()
                            .includes(
                                query
                            ) ||
                        task.description
                            .toLowerCase()
                            .includes(
                                query
                            );

                    const matchesPriority =
                        priority ===
                        "all" ||
                        task.priority ===
                        priority;

                    return (
                        matchesQuery &&
                        matchesPriority
                    );
                }
            );

        const groups = {
            todo:
                filtered.filter(
                    task =>
                        task.status ===
                        "todo"
                ),

            inProgress:
                filtered.filter(
                    task =>
                        task.status ===
                        "inProgress"
                ),

            done:
                filtered.filter(
                    task =>
                        task.status ===
                        "done"
                )
        };

        els.todoCount.textContent =
            state.tasks.filter(
                task =>
                    task.status ===
                    "todo"
            ).length;

        els.inProgressCount.textContent =
            state.tasks.filter(
                task =>
                    task.status ===
                    "inProgress"
            ).length;

        els.doneCount.textContent =
            state.tasks.filter(
                task =>
                    task.status ===
                    "done"
            ).length;

        renderTaskColumn(
            els.todoList,
            groups.todo,
            "todo"
        );

        renderTaskColumn(
            els.inProgressList,
            groups.inProgress,
            "inProgress"
        );

        renderTaskColumn(
            els.doneList,
            groups.done,
            "done"
        );

        renderSessionTaskOptions();
    }

    function renderTaskColumn(
        container,
        tasks,
        status
    ) {
        if (!tasks.length) {
            container.innerHTML =
                `
<div class="empty-state">
No tasks here.
</div>
`;

            return;
        }

        const statusAction = {
            todo: {
                next:
                    "inProgress",

                label:
                    "Start"
            },

            inProgress: {
                next:
                    "done",

                label:
                    "Complete"
            },

            done: {
                next:
                    "todo",

                label:
                    "Reopen"
            }
        }[status];

        container.innerHTML =
            tasks
                .sort(
                    (
                        a,
                        b
                    ) =>
                        b.createdAt -
                        a.createdAt
                )
                .map(
                    task => `
<article class="task-card">
<div class="task-card__top">
<div class="task-card__badges">

<span class="priority-badge priority-${task.priority}">
${task.priority}
</span>

${status === "done" &&
                            task.unverifiedCompletion
                            ? `
<span
class="unverified-badge"
title="Marked complete without a logged study session"
>
Unverified
</span>
`
                            : ""
                        }

</div>

<button
class="task-menu-button"
data-edit-task="${task.id}"
title="Edit task"
>
✎
</button>
</div>

<h4>
${escapeHtml(
                            task.title
                        )}
</h4>

<p>
${escapeHtml(
                            task.description ||
                            "No description added."
                        )}
</p>

${task.resourceId
                            ? `
<div class="linked-resource">
📎 ${escapeHtml(
                                getResource(
                                    task.resourceId
                                )?.title ||
                                "Linked resource"
                            )}
</div>
`
                            : ""
                        }

<div class="task-card__footer">
<span>
${task.dueDate
                            ? `Due ${formatDate(
                                task.dueDate
                            )}`
                            : "No due date"
                        }
</span>

<div class="task-card__actions">

${task.resourceId &&
                            status !== "done"
                            ? `
<button
class="task-action-button"
data-study-task="${task.id}"
>
Study
</button>
`
                            : ""
                        }

<button
class="task-action-button"
data-move-task="${task.id}"
data-next-status="${statusAction.next}"
>
${statusAction.label}
</button>

<button
class="task-action-button"
data-delete-task="${task.id}"
>
Delete
</button>

</div>
</div>
</article>
`
                )
                .join("");
    }

    function openTaskEditor(
        task = null
    ) {
        els.taskForm.reset();

        els.editingTaskId.value =
            task?.id ||
            "";

        els.taskModalTitle.textContent =
            task
                ? "Edit task"
                : "Add a new task";

        els.taskTitle.value =
            task?.title ||
            "";

        els.taskDescription.value =
            task?.description ||
            "";

        els.taskPriority.value =
            task?.priority ||
            "medium";

        els.taskDueDate.value =
            task?.dueDate ||
            "";

        populateTaskResources();

        els.taskStatus.value =
            task?.status ||
            "todo";

        els.taskResource.value =
            task?.resourceId ||
            "";

        openModal(
            els.taskModal
        );

        setTimeout(
            () =>
                els.taskTitle.focus(),
            100
        );
    }

    function saveTask(event) {
        event.preventDefault();

        const id =
            els.editingTaskId.value;

        const taskData = {
            title:
                els.taskTitle.value.trim(),

            description:
                els.taskDescription.value.trim(),

            priority:
                els.taskPriority.value,

            dueDate:
                els.taskDueDate.value,

            status:
                els.taskStatus.value,

            resourceId:
                els.taskResource.value
        };

        if (!taskData.title) {
            showToast(
                "Please enter a task title.",
                "error"
            );

            return;
        }

        if (id) {
            const task =
                state.tasks.find(
                    item =>
                        item.id ===
                        id
                );

            if (task) {
                Object.assign(
                    task,
                    taskData
                );
            }

            showToast(
                "Task updated."
            );

        } else {
            state.tasks.push({
                id:
                    crypto.randomUUID(),

                ...taskData,

                createdAt:
                    Date.now()
            });

            showToast(
                "Task added."
            );
        }

        saveState();

        closeModal(
            els.taskModal
        );

        renderTasks();

        renderDashboard();
    }

    function deleteTask(id) {
        const task =
            state.tasks.find(
                item =>
                    item.id ===
                    id
            );

        if (!task) {
            return;
        }

        if (
            !window.confirm(
                `Delete "${task.title}"?`
            )
        ) {
            return;
        }

        state.tasks =
            state.tasks.filter(
                item =>
                    item.id !==
                    id
            );

        saveState();

        renderTasks();

        renderDashboard();

        showToast(
            "Task deleted.",
            "warning"
        );
    }

    const MIN_VERIFIED_MINUTES_FOR_COMPLETION =
        1;

    function getLoggedMinutesForTask(
        taskId
    ) {
        return state.sessions
            .filter(
                session =>
                    session.taskId ===
                    taskId
            )
            .reduce(
                (
                    sum,
                    session
                ) =>
                    sum +
                    session.durationMinutes,
                0
            );
    }

    function moveTask(
        id,
        nextStatus
    ) {
        const task =
            state.tasks.find(
                item =>
                    item.id ===
                    id
            );

        if (!task) {
            return;
        }

        if (
            nextStatus === "done" &&
            task.status !== "done"
        ) {
            const loggedMinutes =
                getLoggedMinutesForTask(
                    task.id
                );

            if (
                loggedMinutes <
                MIN_VERIFIED_MINUTES_FOR_COMPLETION
            ) {
                const proceed =
                    window.confirm(
                        "No study session is logged against this task yet. Mark it complete anyway? " +
                        "(This will be flagged as an unverified completion.)"
                    );

                if (!proceed) {
                    return;
                }

                task.unverifiedCompletion =
                    true;

            } else {
                task.unverifiedCompletion =
                    false;
            }
        }

        task.status =
            nextStatus;

        saveState();

        renderTasks();

        renderDashboard();

        renderProgress();

        showToast(
            nextStatus === "done"
                ? "Task completed."
                : "Task status updated."
        );
    }

    // -------------------------------------------------------------
    // TIMER
    // -------------------------------------------------------------

    function getModeMinutes(mode) {
        if (
            mode ===
            "shortBreak"
        ) {
            return state.settings.shortBreakMinutes;
        }

        if (
            mode ===
            "longBreak"
        ) {
            return state.settings.longBreakMinutes;
        }

        return state.settings.focusMinutes;
    }

    function getModeLabel(mode) {
        if (
            mode ===
            "shortBreak"
        ) {
            return "Short break";
        }

        if (
            mode ===
            "longBreak"
        ) {
            return "Long break";
        }

        return "Focus session";
    }

    function setTimerMode(
        mode,
        force = false
    ) {
        if (
            timer.running &&
            !force
        ) {
            showToast(
                "Pause or reset the active timer before changing modes.",
                "warning"
            );

            return;
        }

        clearTimerIntervals();

        timer.mode =
            mode;

        timer.totalSeconds =
            getModeMinutes(
                mode
            ) *
            60;

        timer.remainingSeconds =
            timer.totalSeconds;

        timer.running =
            false;

        timer.sessionStartedAt =
            null;

        timer.focusViolations =
            0;

        timer.checksPassed =
            0;

        timer.checksFailed =
            0;

        timer.nextVerificationAt =
            null;

        timer.backgroundPrep =
            null;

        els.modeTabs.forEach(
            tab =>
                tab.classList.toggle(
                    "active",
                    tab.dataset.mode ===
                    mode
                )
        );

        updateTimerUI();
    }

    function updateTimerUI() {
        const minutes =
            Math.floor(
                timer.remainingSeconds /
                60
            );

        const seconds =
            timer.remainingSeconds %
            60;

        els.timerDisplay.textContent =
            `${String(
                minutes
            ).padStart(
                2,
                "0"
            )}:${String(
                seconds
            ).padStart(
                2,
                "0"
            )}`;

        const elapsed =
            timer.totalSeconds -
            timer.remainingSeconds;

        const progress =
            timer.totalSeconds
                ? (
                    elapsed /
                    timer.totalSeconds
                ) *
                360
                : 0;

        els.timerRing.style.setProperty(
            "--progress",
            `${progress}deg`
        );

        els.timerModeLabel.textContent =
            getModeLabel(
                timer.mode
            );

        els.timerStatus.textContent =
            timer.running
                ? "In progress"
                : timer.remainingSeconds <
                    timer.totalSeconds
                    ? "Paused"
                    : "Ready";

        els.startPauseTimer.textContent =
            timer.running
                ? "Pause"
                : timer.remainingSeconds <
                    timer.totalSeconds
                    ? "Resume"
                    : "Start";

        els.sessionCycle.textContent =
            `${timer.cycle} of ${state.settings.cyclesBeforeLongBreak}`;

        els.focusViolationCount.textContent =
            timer.focusViolations;

        els.checksPassedCount.textContent =
            timer.checksPassed;

        document.title =
            timer.running
                ? `${els.timerDisplay.textContent} • ${getModeLabel(
                    timer.mode
                )}`
                : "Digital Study Companion";
    }

    let timerStartInProgress =
        false;

    function toggleTimer() {
        if (
            timerStartInProgress
        ) {
            return;
        }

        if (
            timer.running
        ) {
            pauseTimer(
                "Paused"
            );

            return;
        }

        startTimer();
    }

    async function startTimer() {
        if (
            timer.running ||
            timerStartInProgress
        ) {
            return;
        }

        timerStartInProgress =
            true;

        try {
            if (
                timer.mode ===
                "focus" &&
                state.settings.focusTracking &&
                !document.fullscreenElement
            ) {
                if (
                    !document.documentElement.requestFullscreen
                ) {
                    updateTimerUI();

                    els.timerStatus.textContent =
                        "Fullscreen required";

                    showToast(
                        "Full screen is required for a focus session, but this browser does not support it.",
                        "error"
                    );

                    return;
                }

                try {
                    await document.documentElement.requestFullscreen();

                } catch (error) {
                    console.warn(
                        "Could not enter required fullscreen mode.",
                        error
                    );

                    timer.running =
                        false;

                    updateTimerUI();

                    els.timerStatus.textContent =
                        "Fullscreen required";

                    showToast(
                        "A focus session can only start in full screen. Allow full screen and try again.",
                        "error"
                    );

                    return;
                }

                if (
                    !document.fullscreenElement
                ) {
                    timer.running =
                        false;

                    updateTimerUI();

                    els.timerStatus.textContent =
                        "Fullscreen required";

                    showToast(
                        "Full screen is required before the focus timer can start.",
                        "error"
                    );

                    return;
                }
            }

            if (
                timer.mode ===
                "focus" &&
                timer.remainingSeconds ===
                timer.totalSeconds
            ) {
                timer.sessionStartedAt =
                    Date.now();

                timer.focusViolations =
                    0;

                timer.checksPassed =
                    0;

                timer.checksFailed =
                    0;

                scheduleNextVerification();
            }

            timer.running =
                true;

            timer.automaticallyPausedByBlur =
                false;

            if (
                timer.intervalId
            ) {
                window.clearInterval(
                    timer.intervalId
                );
            }

            timer.intervalId =
                window.setInterval(
                    tickTimer,
                    1000
                );

            updateTimerUI();

        } finally {
            timerStartInProgress =
                false;
        }
    }

    function pauseTimer(
        status = "Paused"
    ) {
        timer.running =
            false;

        if (
            timer.intervalId
        ) {
            window.clearInterval(
                timer.intervalId
            );
        }

        timer.intervalId =
            null;

        els.timerStatus.textContent =
            status;

        updateTimerUI();

        if (
            document.fullscreenElement
        ) {
            document
                .exitFullscreen()
                .catch(
                    () => { }
                );
        }
    }

    function resetTimer() {
        clearTimerIntervals();

        timer.running =
            false;

        timer.remainingSeconds =
            timer.totalSeconds;

        timer.sessionStartedAt =
            null;

        timer.focusViolations =
            0;

        timer.checksPassed =
            0;

        timer.checksFailed =
            0;

        timer.nextVerificationAt =
            null;

        closeModal(
            els.verificationModal
        );

        updateTimerUI();

        showToast(
            "Timer reset.",
            "warning"
        );
    }

    function skipTimer() {
        if (
            timer.mode ===
            "focus" &&
            timer.remainingSeconds <
            timer.totalSeconds
        ) {
            if (
                !window.confirm(
                    "Skip this focus session? Its progress will not be logged."
                )
            ) {
                return;
            }
        }

        completeTimer(
            true
        );
    }

    function tickTimer() {
        timer.remainingSeconds -=
            1;

        if (
            timer.mode ===
            "focus" &&
            state.settings.verificationChecks &&
            timer.nextVerificationAt &&
            Date.now() >=
            timer.nextVerificationAt &&
            els.verificationModal.classList.contains(
                "hidden"
            )
        ) {
            showVerificationCheck();
        }

        if (
            timer.remainingSeconds <=
            0
        ) {
            timer.remainingSeconds =
                0;

            completeTimer(
                false
            );
        }

        updateTimerUI();
    }

    function clearTimerIntervals() {
        if (
            timer.intervalId
        ) {
            window.clearInterval(
                timer.intervalId
            );
        }

        if (
            timer.verificationTimeoutId
        ) {
            window.clearTimeout(
                timer.verificationTimeoutId
            );
        }

        if (
            timer.verificationIntervalId
        ) {
            window.clearInterval(
                timer.verificationIntervalId
            );
        }

        timer.intervalId =
            null;

        timer.verificationTimeoutId =
            null;

        timer.verificationIntervalId =
            null;
    }

    function completeTimer(
        skipped
    ) {
        clearTimerIntervals();

        timer.running =
            false;

        closeModal(
            els.verificationModal
        );

        playTone(
            660
        );

        if (
            timer.mode ===
            "focus" &&
            !skipped
        ) {
            timer.pendingCompletion = {
                durationMinutes:
                    Math.max(
                        1,
                        Math.round(
                            timer.totalSeconds /
                            60
                        )
                    ),

                completedAt:
                    Date.now(),

                taskId:
                    els.sessionTask.value ||
                    null,

                resourceId:
                    timer.activeResourceId ||
                    null,

                goal:
                    els.sessionGoal.value.trim(),

                focusViolations:
                    timer.focusViolations,

                checksPassed:
                    timer.checksPassed,

                checksFailed:
                    timer.checksFailed
            };

            prepareReflectionModal();

            openModal(
                els.reflectionModal
            );

            return;
        }

        if (
            timer.mode ===
            "focus"
        ) {
            const nextMode =
                timer.cycle >=
                    state.settings.cyclesBeforeLongBreak
                    ? "longBreak"
                    : "shortBreak";

            if (
                timer.cycle >=
                state.settings.cyclesBeforeLongBreak
            ) {
                timer.cycle = 1;

            } else {
                timer.cycle += 1;
            }

            setTimerMode(
                nextMode,
                true
            );

        } else {
            setTimerMode(
                "focus",
                true
            );
        }

        showToast(
            skipped
                ? "Timer skipped."
                : "Break complete."
        );
    }

    function scheduleNextVerification() {
        if (
            !state.settings.verificationChecks ||
            timer.mode !==
            "focus"
        ) {
            timer.nextVerificationAt =
                null;

            return;
        }

        const totalMs =
            timer.totalSeconds *
            1000;

        const minimum =
            Math.min(
                8 *
                60 *
                1000,

                totalMs *
                0.35
            );

        const maximum =
            Math.min(
                18 *
                60 *
                1000,

                totalMs *
                0.75
            );

        if (
            maximum <=
            30000 ||
            maximum <=
            minimum
        ) {
            timer.nextVerificationAt =
                Date.now() +
                Math.max(
                    15000,
                    totalMs *
                    0.5
                );

            return;
        }

        timer.nextVerificationAt =
            Date.now() +
            minimum +
            Math.random() *
            (
                maximum -
                minimum
            );
    }

    function showVerificationCheck() {
        if (
            !timer.running ||
            timer.mode !==
            "focus"
        ) {
            return;
        }

        pauseTimer(
            "Presence check"
        );

        playTone(
            880
        );

        openModal(
            els.verificationModal
        );

        let seconds = 15;

        els.verificationCountdown.textContent =
            seconds;

        timer.verificationIntervalId =
            window.setInterval(
                () => {
                    seconds -= 1;

                    els.verificationCountdown.textContent =
                        Math.max(
                            0,
                            seconds
                        );
                },
                1000
            );

        timer.verificationTimeoutId =
            window.setTimeout(
                () => {
                    window.clearInterval(
                        timer.verificationIntervalId
                    );

                    timer.verificationIntervalId =
                        null;

                    timer.verificationTimeoutId =
                        null;

                    timer.checksFailed +=
                        1;

                    timer.focusViolations +=
                        1;

                    closeModal(
                        els.verificationModal
                    );

                    updateTimerUI();

                    showToast(
                        "Presence check missed. The session was flagged and remains paused.",
                        "error"
                    );

                    timer.nextVerificationAt =
                        null;
                },
                15000
            );
    }

    function confirmPresence() {
        if (
            timer.verificationTimeoutId
        ) {
            window.clearTimeout(
                timer.verificationTimeoutId
            );
        }

        if (
            timer.verificationIntervalId
        ) {
            window.clearInterval(
                timer.verificationIntervalId
            );
        }

        timer.verificationTimeoutId =
            null;

        timer.verificationIntervalId =
            null;

        timer.checksPassed +=
            1;

        closeModal(
            els.verificationModal
        );

        scheduleNextVerification();

        startTimer();

        showToast(
            "Presence confirmed. Keep going."
        );
    }

    function playTone(
        frequency = 700
    ) {
        if (
            !state.settings.sound
        ) {
            return;
        }

        try {
            const AudioContext =
                window.AudioContext ||
                window.webkitAudioContext;

            const context =
                new AudioContext();

            const oscillator =
                context.createOscillator();

            const gain =
                context.createGain();

            oscillator.type =
                "sine";

            oscillator.frequency.value =
                frequency;

            gain.gain.setValueAtTime(
                0.0001,
                context.currentTime
            );

            gain.gain.exponentialRampToValueAtTime(
                0.15,
                context.currentTime +
                0.02
            );

            gain.gain.exponentialRampToValueAtTime(
                0.0001,
                context.currentTime +
                0.35
            );

            oscillator.connect(
                gain
            );

            gain.connect(
                context.destination
            );

            oscillator.start();

            oscillator.stop(
                context.currentTime +
                0.38
            );

        } catch (error) {
            console.warn(
                "Sound could not be played.",
                error
            );
        }
    }

    // -------------------------------------------------------------
    // REFLECTION
    // -------------------------------------------------------------

    function prepareReflectionModal() {
        const task =
            state.tasks.find(
                item =>
                    item.id ===
                    timer.pendingCompletion?.taskId
            );

        const resourceId =
            task?.resourceId ||
            timer.pendingCompletion?.resourceId;

        const resource =
            resourceId
                ? getResource(
                    resourceId
                )
                : null;

        els.reflectionResourceNote.textContent =
            resource
                ? `This session was logged against "${resource.title}". Summarise what you understood about this topic, in your own words — you don't need to use the same wording as the resource.`
                : "";

        els.reflectionResourceNote.classList.toggle(
            "hidden",
            !resource
        );

        els.reflectionText.value =
            "";

        els.reflectionCount.textContent =
            "0";

        els.reflectionValidation.textContent =
            "At least 40 characters are required.";

        els.reflectionAlignment.textContent =
            "";

        els.reflectionAlignment.className =
            "alignment-status";

        els.saveReflection.disabled =
            true;

        startBackgroundAssessmentPrep(
            resource,
            task
        );

        setTimeout(
            () =>
                els.reflectionText.focus(),
            100
        );
    }

    async function assistReflectionWithGemini() {
        const task =
            state.tasks.find(
                item =>
                    item.id ===
                    timer.pendingCompletion?.taskId
            );

        const topic =
            task?.title ||
            timer.pendingCompletion?.goal ||
            "General study topic";

        showToast(
            "Generating reflection prompt from Gemini...",
            "info"
        );

        const prompt =
            `I am a student writing a short summary of what I learned in a study session on: "${topic}". Give me 2 short guiding reflection bullet points or questions to help me summarize my thoughts effectively in my study log. Keep it under 40 words total.`;

        const aiResponse =
            await askGemini(
                prompt
            );

        if (aiResponse) {
            els.reflectionText.value =
                `I focused on ${topic}. ${aiResponse.replace(
                    /[*#]/g,
                    ""
                )
                }`;

            validateReflection();
        }
    }

    function validateReflection() {
        const value =
            els.reflectionText.value.trim();

        els.reflectionCount.textContent =
            els.reflectionText.value.length;

        const hasEnoughLength =
            value.length >=
            40;

        const hasVariety =
            new Set(
                value
                    .toLowerCase()
                    .replace(
                        /[^a-z0-9]/g,
                        ""
                    )
            ).size >=
            10;

        const words =
            value
                .split(
                    /\s+/
                )
                .filter(
                    Boolean
                );

        const hasWords =
            words.length >=
            7;

        const wordCounts = {};

        words.forEach(
            word => {
                const key =
                    word.toLowerCase();

                wordCounts[key] =
                    (
                        wordCounts[key] ||
                        0
                    ) +
                    1;
            }
        );

        const notRepetitive =
            words.length ===
            0 ||
            Math.max(
                ...Object.values(
                    wordCounts
                )
            ) /
            words.length <=
            0.4;

        const basicsValid =
            hasEnoughLength &&
            hasVariety &&
            hasWords &&
            notRepetitive;

        els.saveReflection.disabled =
            !basicsValid;

        els.reflectionValidation.textContent =
            basicsValid
                ? ""
                : "Write at least 40 characters using seven or more varied, meaningful words.";

        els.reflectionAlignment.className =
            "alignment-status";

        els.reflectionAlignment.textContent =
            "";
    }

    function stripCodeFence(
        value = ""
    ) {
        return String(
            value ||
            ""
        )
            .trim()
            .replace(
                /^```(?:json)?\s*/i,
                ""
            )
            .replace(
                /\s*```$/,
                ""
            )
            .trim();
    }

    function parseJsonObjectFromAi(value) {
        let cleaned =
            String(
                value ||
                ""
            ).trim();

        cleaned =
            cleaned
                .replace(
                    /^```(?:json)?\s*/i,
                    ""
                )
                .replace(
                    /\s*```$/i,
                    ""
                )
                .trim();

        try {
            return JSON.parse(
                cleaned
            );

        } catch (_) {
        }

        const firstBrace =
            cleaned.indexOf(
                "{"
            );

        const lastBrace =
            cleaned.lastIndexOf(
                "}"
            );

        if (
            firstBrace !== -1 &&
            lastBrace >
            firstBrace
        ) {
            const candidate =
                cleaned.slice(
                    firstBrace,
                    lastBrace +
                    1
                );

            try {
                return JSON.parse(
                    candidate
                );

            } catch (_) {
                cleaned =
                    candidate;
            }
        }

        const repaired =
            cleaned
                .replace(
                    /,\s*([}\]])/g,
                    "$1"
                )
                .replace(
                    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
                    ""
                );

        try {
            return JSON.parse(
                repaired
            );

        } catch (error) {
            console.error(
                "Assessment JSON parse failed.",
                {
                    original:
                        value,

                    cleaned,

                    repaired,

                    error
                }
            );

            throw new Error(
                "The AI returned malformed assessment data."
            );
        }
    }

    // -------------------------------------------------------------
    // YOUTUBE / RESOURCE TEXT EXTRACTION
    // -------------------------------------------------------------

    function extractYoutubeVideoId(
        url = ""
    ) {
        const match =
            String(
                url
            ).match(
                /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/
            );

        return match
            ? match[1]
            : null;
    }

    async function fetchYoutubeTranscript(
        videoId
    ) {
        try {
            const {
                data,
                error
            } =
                await supabase.functions.invoke(
                    "youtube-transcript",
                    {
                        body: {
                            videoId
                        }
                    }
                );

            if (error) {
                console.warn(
                    "YouTube transcript fetch failed.",
                    error
                );

                return "";
            }

            return typeof data?.transcript ===
                "string"
                ? data.transcript
                : "";

        } catch (error) {
            console.warn(
                "YouTube transcript fetch failed.",
                error
            );

            return "";
        }
    }

    async function extractResourceStudyText(
        resource
    ) {
        if (!resource) {
            return "";
        }

        const metadata = [
            resource.title,
            resource.notes,
            resource.fileName,
            resource.url
        ]
            .filter(
                Boolean
            )
            .join(
                "\n"
            );

        if (
            resource.kind ===
            "link"
        ) {
            const videoId =
                extractYoutubeVideoId(
                    resource.url ||
                    ""
                );

            if (videoId) {
                const transcript =
                    await fetchYoutubeTranscript(
                        videoId
                    );

                return transcript
                    ? `${metadata}\n\nVIDEO TRANSCRIPT:\n${transcript}`
                    : metadata;
            }

            return metadata;
        }

        const file =
            await getResourceFileBlob(
                resource
            );

        if (!file) {
            return metadata;
        }

        try {
            if (
                resource.mimeType ===
                "application/pdf" &&
                window.pdfjsLib
            ) {
                const bytes =
                    new Uint8Array(
                        await file.arrayBuffer()
                    );

                const pdf =
                    await window.pdfjsLib
                        .getDocument({
                            data:
                                bytes
                        })
                        .promise;

                const progress =
                    resource.readProgress?.kind ===
                        "pdf"
                        ? resource.readProgress
                        : null;

                const pageLimit =
                    progress?.maxPage
                        ? Math.min(
                            pdf.numPages,
                            progress.maxPage,
                            60
                        )
                        : Math.min(
                            pdf.numPages,
                            30
                        );

                const pages = [];

                for (
                    let pageNumber = 1;
                    pageNumber <=
                    pageLimit;
                    pageNumber += 1
                ) {
                    const page =
                        await pdf.getPage(
                            pageNumber
                        );

                    const content =
                        await page.getTextContent();

                    pages.push(
                        content.items
                            .map(
                                item =>
                                    item.str
                            )
                            .join(
                                " "
                            )
                    );
                }

                return `${metadata}\n\n${pages.join(
                    "\n"
                )}`.slice(
                    0,
                    60000
                );
            }

            if (
                isDocxResource(
                    resource
                ) &&
                window.mammoth
            ) {
                const arrayBuffer =
                    await file.arrayBuffer();

                const result =
                    await window.mammoth.extractRawText({
                        arrayBuffer
                    });

                const progress =
                    resource.readProgress?.kind ===
                        "docx"
                        ? resource.readProgress
                        : null;

                const fullText =
                    result.value;

                const limitedText =
                    progress?.maxPercent
                        ? fullText.slice(
                            0,
                            Math.max(
                                500,
                                Math.floor(
                                    fullText.length *
                                    progress.maxPercent
                                )
                            )
                        )
                        : fullText;

                return `${metadata}\n\n${limitedText}`.slice(
                    0,
                    60000
                );
            }

            if (
                resource.mimeType.startsWith(
                    "text/"
                ) ||
                /\.(txt|md|csv|json|html?|js|ts|css|py|java|c|cpp|sql)$/i.test(
                    resource.fileName ||
                    ""
                )
            ) {
                const fullText =
                    await file.text();

                const progress =
                    resource.readProgress?.kind ===
                        "text"
                        ? resource.readProgress
                        : null;

                const limitedText =
                    progress?.maxPercent
                        ? fullText.slice(
                            0,
                            Math.max(
                                500,
                                Math.floor(
                                    fullText.length *
                                    progress.maxPercent
                                )
                            )
                        )
                        : fullText;

                return `${metadata}\n\n${limitedText}`.slice(
                    0,
                    60000
                );
            }

        } catch (error) {
            console.warn(
                "Could not extract resource text.",
                error
            );
        }

        return metadata;
    }

    // -------------------------------------------------------------
    // TUTOR CHAT
    // -------------------------------------------------------------

    async function openTutorChatFor(
        resourceId
    ) {
        const resource =
            getResource(
                resourceId
            );

        if (!resource) {
            showToast(
                "Open a resource first to chat with the tutor about it.",
                "error"
            );

            return;
        }

        if (
            tutorChat.resourceId !==
            resource.id
        ) {
            tutorChat.resourceId =
                resource.id;

            tutorChat.resourceTitle =
                resource.title;

            tutorChat.history =
                [];

            tutorChat.context =
                "";

            tutorChat.attachment =
                null;

            renderTutorAttachmentPreview();
        }

        els.tutorChatResourceNote.textContent =
            `About: ${resource.title}`;

        openModal(
            els.tutorChatModal
        );

        renderTutorMessages();

        setTimeout(
            () =>
                els.tutorChatInput.focus(),
            100
        );

        if (
            !tutorChat.context
        ) {
            els.tutorChatMessages.innerHTML =
                `<p class="tutor-chat-empty">Reading the resource…</p>`;

            tutorChat.context =
                await extractResourceStudyText(
                    resource
                );

            renderTutorMessages();
        }
    }

    function resetTutorChat() {
        tutorChat.history =
            [];

        tutorChat.attachment =
            null;

        renderTutorAttachmentPreview();

        renderTutorMessages();

        els.tutorChatInput.value =
            "";

        els.tutorChatInput.focus();
    }

    function renderTutorMessages() {
        if (
            !tutorChat.history.length
        ) {
            els.tutorChatMessages.innerHTML =
                `<p class="tutor-chat-empty">Ask anything about "${escapeHtml(
                    tutorChat.resourceTitle
                )}" — definitions, summaries, worked examples, or anything else. I can also help beyond this resource if you ask.</p>`;

            return;
        }

        els.tutorChatMessages.innerHTML =
            tutorChat.history
                .map(
                    msg => {
                        const attachment =
                            msg.attachmentName
                                ? `<div class="tutor-msg-attachment">📎 ${escapeHtml(
                                    msg.attachmentName
                                )}</div>`
                                : "";

                        const body =
                            msg.role ===
                                "assistant"
                                ? renderMarkdown(
                                    msg.text
                                )
                                : escapeHtml(
                                    msg.text
                                );

                        return `
<div class="tutor-msg ${msg.role ===
                                "user"
                                ? "user"
                                : "assistant"
                            }">
${attachment}
${body}
</div>
`;
                    }
                )
                .join("");

        els.tutorChatMessages.scrollTop =
            els.tutorChatMessages.scrollHeight;
    }

    function setTutorTyping(
        visible
    ) {
        const existing =
            els.tutorChatMessages.querySelector(
                ".tutor-msg.typing"
            );

        if (!visible) {
            if (
                existing
            ) {
                existing.remove();
            }

            return;
        }

        if (
            existing
        ) {
            return;
        }

        const bubble =
            document.createElement(
                "div"
            );

        bubble.className =
            "tutor-msg typing";

        bubble.innerHTML =
            "<span></span><span></span><span></span>";

        els.tutorChatMessages.appendChild(
            bubble
        );

        els.tutorChatMessages.scrollTop =
            els.tutorChatMessages.scrollHeight;
    }

    const RESOURCE_REFERENCE_PATTERN =
        /\b(this|the)\s+(resource|document|pdf|file|reading|material|text|article|chapter|notes?)\b|based on (this|the) (resource|document|pdf|file|reading|material)|according to (this|the) (resource|document|pdf|file|reading|material)/i;

    function messageReferencesResource(
        question
    ) {
        return RESOURCE_REFERENCE_PATTERN.test(
            question
        );
    }

    function fileToBase64(
        file
    ) {
        return new Promise(
            (
                resolve,
                reject
            ) => {
                const reader =
                    new FileReader();

                reader.onload =
                    () =>
                        resolve(
                            String(
                                reader.result
                            ).split(
                                ","
                            )[1] ||
                            ""
                        );

                reader.onerror =
                    () =>
                        reject(
                            new Error(
                                "Could not read that file."
                            )
                        );

                reader.readAsDataURL(
                    file
                );
            }
        );
    }

    async function handleTutorFileSelected(
        event
    ) {
        const file =
            event.target.files?.[0];

        event.target.value =
            "";

        if (!file) {
            return;
        }

        if (
            !TUTOR_ATTACHMENT_TYPES.includes(
                file.type
            )
        ) {
            showToast(
                "Attach an image (PNG/JPEG/WEBP/HEIC) or a PDF.",
                "error"
            );

            return;
        }

        if (
            file.size >
            TUTOR_ATTACHMENT_MAX_BYTES
        ) {
            showToast(
                "That file is too large to attach (max 15MB).",
                "error"
            );

            return;
        }

        try {
            const base64 =
                await fileToBase64(
                    file
                );

            tutorChat.attachment = {
                base64,

                mimeType:
                    file.type,

                name:
                    file.name
            };

            renderTutorAttachmentPreview();

        } catch (error) {
            console.error(
                "Failed to read tutor attachment:",
                error
            );

            showToast(
                "Could not read that file. Try another.",
                "error"
            );
        }
    }

    function clearTutorAttachment() {
        tutorChat.attachment =
            null;

        renderTutorAttachmentPreview();
    }

    function renderTutorAttachmentPreview() {
        if (
            !els.tutorChatAttachmentPreview
        ) {
            return;
        }

        const attachment =
            tutorChat.attachment;

        if (!attachment) {
            els.tutorChatAttachmentPreview.innerHTML =
                "";

            els.tutorChatAttachmentPreview.classList.add(
                "hidden"
            );

            return;
        }

        const icon =
            attachment.mimeType ===
                "application/pdf"
                ? "📄"
                : "🖼️";

        els.tutorChatAttachmentPreview.classList.remove(
            "hidden"
        );

        els.tutorChatAttachmentPreview.innerHTML =
            `
<span class="tutor-attachment-chip">
${icon}
${escapeHtml(
                attachment.name
            )}

<button
type="button"
id="tutorChatRemoveAttachment"
aria-label="Remove attachment"
>
✕
</button>
</span>
`;

        const removeButton =
            document.getElementById(
                "tutorChatRemoveAttachment"
            );

        if (
            removeButton
        ) {
            removeButton.addEventListener(
                "click",
                clearTutorAttachment
            );
        }
    }

    function normaliseUserMessage(
        text
    ) {
        return String(
            text ||
            ""
        )
            .split(
                "\n"
            )
            .map(
                line =>
                    line
                        .replace(
                            /[ \t]+/g,
                            " "
                        )
                        .trim()
            )
            .filter(
                (
                    line,
                    index,
                    lines
                ) =>
                    line ||
                    (
                        index >
                        0 &&
                        index <
                        lines.length -
                        1
                    )
            )
            .join(
                "\n"
            )
            .trim();
    }

    async function sendTutorChatMessage(
        event
    ) {
        event.preventDefault();

        if (
            tutorChat.sending
        ) {
            return;
        }

        const question =
            normaliseUserMessage(
                els.tutorChatInput.value
            );

        const attachment =
            tutorChat.attachment;

        if (
            !question &&
            !attachment
        ) {
            return;
        }

        const resource =
            getResource(
                tutorChat.resourceId
            );

        if (!resource) {
            showToast(
                "That resource is no longer available.",
                "error"
            );

            return;
        }

        tutorChat.sending =
            true;

        els.tutorChatSend.disabled =
            true;

        els.tutorChatInput.value =
            "";

        tutorChat.history.push({
            role:
                "user",

            text:
                question ||
                (
                    attachment
                        ? `[Attached: ${attachment.name}]`
                        : ""
                ),

            attachmentName:
                attachment?.name ||
                null
        });

        tutorChat.attachment =
            null;

        renderTutorAttachmentPreview();

        renderTutorMessages();

        setTutorTyping(
            true
        );

        try {
            const historyForApi =
                tutorChat.history
                    .slice(
                        0,
                        -1
                    )
                    .map(
                        msg => ({
                            role:
                                msg.role,

                            text:
                                msg.text
                        })
                    );

            const useResourceContext =
                tutorChat.context &&
                tutorChat.context
                    .trim()
                    .length >=
                20;

            const p =
                state.profile ||
                {};

            const studentProfile = {
                name:
                    p.name ||
                    "",

                school:
                    p.school ||
                    "",

                course:
                    p.course ||
                    "",

                department:
                    p.department ||
                    "",

                level:
                    p.level ||
                    ""
            };

            const hasStudentProfile =
                Object.values(
                    studentProfile
                ).some(
                    Boolean
                );

            const answer =
                await askGemini(
                    question ||
                    "Look at the attached file and help me understand it.",
                    {
                        mode:
                            "tutor",

                        resourceTitle:
                            tutorChat.resourceTitle,

                        resourceContext:
                            useResourceContext
                                ? tutorChat.context.slice(
                                    0,
                                    60000
                                )
                                : "",

                        groundingMode:
                            messageReferencesResource(
                                question
                            )
                                ? "resource"
                                : "general",

                        chatHistory:
                            historyForApi.slice(
                                -12
                            ),

                        studentProfile:
                            hasStudentProfile
                                ? studentProfile
                                : null,

                        attachment:
                            attachment
                                ? {
                                    mimeType:
                                        attachment.mimeType,

                                    data:
                                        attachment.base64
                                }
                                : null
                    }
                );

            setTutorTyping(
                false
            );

            tutorChat.history.push({
                role:
                    "assistant",

                text:
                    answer
            });

            renderTutorMessages();

        } catch (error) {
            console.error(
                "Tutor chat failed:",
                error
            );

            setTutorTyping(
                false
            );

            tutorChat.history.push({
                role:
                    "assistant",

                text:
                    describeAiError(
                        error
                    )
            });

            renderTutorMessages();

        } finally {
            tutorChat.sending =
                false;

            els.tutorChatSend.disabled =
                false;

            els.tutorChatInput.focus();
        }
    }

    // -------------------------------------------------------------
    // UNIVERSITY-LEVEL ASSESSMENT
    // -------------------------------------------------------------

    const MIN_ASSESSMENT_QUESTIONS =
        15;

    const MAX_ASSESSMENT_QUESTIONS =
        30;

    const ASSESSMENT_BATCH_SIZE =
        5;

    const ASSESSMENT_BATCH_CONCURRENCY =
        1;

    function computeQuestionCount(
        resourceText
    ) {
        const wordCount =
            String(
                resourceText ||
                ""
            )
                .trim()
                .split(
                    /\s+/
                )
                .filter(
                    Boolean
                )
                .length;

        const scaled =
            Math.round(
                wordCount /
                120
            );

        return Math.max(
            MIN_ASSESSMENT_QUESTIONS,

            Math.min(
                MAX_ASSESSMENT_QUESTIONS,

                scaled ||
                MIN_ASSESSMENT_QUESTIONS
            )
        );
    }

    function normaliseAssessment(
        payload,
        expectedCount =
            MIN_ASSESSMENT_QUESTIONS
    ) {
        const objective =
            Array.isArray(
                payload?.objectiveQuestions
            )
                ? payload.objectiveQuestions
                : [];

        return {
            aligned:
                payload?.aligned ===
                true,

            alignmentScore:
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(
                            payload?.alignmentScore
                        ) ||
                        0
                    )
                ),

            feedback:
                String(
                    payload?.feedback ||
                    ""
                ),

            objectiveQuestions:
                objective
                    .slice(
                        0,
                        expectedCount
                    )
                    .map(
                        (
                            item,
                            index
                        ) => ({
                            question:
                                String(
                                    item?.question ||
                                    `Question ${index + 1}`
                                ),

                            options:
                                Array.isArray(
                                    item?.options
                                )
                                    ? item.options
                                        .slice(
                                            0,
                                            4
                                        )
                                        .map(
                                            String
                                        )
                                    : [],

                            correctAnswer:
                                Math.max(
                                    0,
                                    Math.min(
                                        3,
                                        Number(
                                            item?.correctAnswer
                                        ) ||
                                        0
                                    )
                                ),

                            explanation:
                                String(
                                    item?.explanation ||
                                    ""
                                )
                        })
                    )
        };
    }

    function sliceResourceForAssessment(
        resourceText,
        batchIndex,
        batchCount
    ) {
        const text =
            String(
                resourceText ||
                ""
            );

        if (
            batchCount <=
            1 ||
            text.length <
            12000
        ) {
            return text;
        }

        const overlap =
            1200;

        const baseSize =
            Math.ceil(
                text.length /
                batchCount
            );

        const start =
            Math.max(
                0,

                batchIndex *
                baseSize -
                (
                    batchIndex >
                        0
                        ? overlap
                        : 0
                )
            );

        const end =
            Math.min(
                text.length,

                (
                    batchIndex +
                    1
                ) *
                baseSize +
                (
                    batchIndex <
                        batchCount -
                        1
                        ? overlap
                        : 0
                )
            );

        return text.slice(
            start,
            end
        );
    }

    async function generateAssessmentQuestionBatch(
        resourceText,
        batchQuestionCount,
        resource,
        task,
        batchIndex,
        batchCount
    ) {
        const prompt =
            `You are a university professor creating a rigorous multiple-choice examination.

Create EXACTLY ${batchQuestionCount} questions from the supplied study material.

RESOURCE TITLE:
${resource?.title || task?.title || "Study resource"}

RESOURCE SECTION:
Section ${batchIndex + 1} of ${batchCount}

STUDY MATERIAL:
${resourceText}

ACADEMIC LEVEL:

Questions should resemble serious university examination questions.

Prioritise:

- application
- analysis
- inference
- scenario reasoning
- comparison
- cause and effect
- misconception detection
- connecting concepts
- consequences of applying principles
- multi-step reasoning

At least half of the questions must require reasoning rather than direct recall.

Avoid simple questions such as:

- "What is X?"
- "Which of the following was mentioned?"
- direct quotation recognition
- obvious definition recall

Each question must have exactly FOUR answer options.

Wrong answers must be plausible academic distractors.

Do not create joke answers or obviously incorrect choices.

Every question must be answerable from the supplied study material.

Do not use outside knowledge.

For hypothetical scenarios, the reasoning required to answer them must come entirely from the supplied material.

RETURN FORMAT:

Return ONLY one valid JSON object.

No Markdown.
No code fences.
No introduction.
No conclusion.
No explanation outside the JSON.

Use exactly:

{
"objectiveQuestions": [
{
"question": "Question text",
"options": [
"Option A",
"Option B",
"Option C",
"Option D"
],
"correctAnswer": 0,
"explanation": "Brief explanation"
}
]
}

IMPORTANT:

- objectiveQuestions must contain EXACTLY ${batchQuestionCount} objects.
- Every options array must contain EXACTLY 4 strings.
- correctAnswer must only be 0, 1, 2, or 3.
- Do not place commas after the final array/object item.
- Keep explanations concise.
- Output JSON immediately.`;

        let lastError =
            null;

        for (
            let attempt = 1;
            attempt <=
            3;
            attempt += 1
        ) {
            try {
                const response =
                    await askGemini(
                        prompt,
                        {
                            mode:
                                "assessment-questions"
                        }
                    );

                if (!response) {
                    throw new Error(
                        "The AI returned an empty quiz response."
                    );
                }

                const parsed =
                    parseJsonObjectFromAi(
                        response
                    );

                if (
                    !parsed ||
                    !Array.isArray(
                        parsed.objectiveQuestions
                    )
                ) {
                    throw new Error(
                        "The AI response did not contain objectiveQuestions."
                    );
                }

                const questions =
                    parsed.objectiveQuestions.map(
                        item => ({
                            question:
                                String(
                                    item?.question ||
                                    ""
                                ).trim(),

                            options:
                                Array.isArray(
                                    item?.options
                                )
                                    ? item.options.map(
                                        option =>
                                            String(
                                                option
                                            ).trim()
                                    )
                                    : [],

                            correctAnswer:
                                Number(
                                    item?.correctAnswer
                                ),

                            explanation:
                                String(
                                    item?.explanation ||
                                    ""
                                ).trim()
                        })
                    );

                const valid =
                    questions.length ===
                    batchQuestionCount &&
                    questions.every(
                        question =>
                            question.question &&
                            question.options.length ===
                            4 &&
                            question.options.every(
                                Boolean
                            ) &&
                            Number.isInteger(
                                question.correctAnswer
                            ) &&
                            question.correctAnswer >=
                            0 &&
                            question.correctAnswer <=
                            3
                    );

                if (!valid) {
                    console.warn(
                        "Generated assessment batch failed validation.",
                        {
                            batch:
                                batchIndex +
                                1,

                            attempt,

                            expected:
                                batchQuestionCount,

                            received:
                                questions.length,

                            response
                        }
                    );

                    throw new Error(
                        "The generated quiz batch was incomplete."
                    );
                }

                return questions;

            } catch (error) {
                lastError =
                    error;

                console.warn(
                    `Assessment batch ${batchIndex + 1}/${batchCount} attempt ${attempt}/3 failed.`,
                    error
                );

                if (
                    attempt <
                    3
                ) {
                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                500 *
                                attempt
                            )
                    );
                }
            }
        }

        throw (
            lastError ||
            new Error(
                "Assessment generation failed."
            )
        );
    }

    async function generateAssessmentQuestions(
        resourceText,
        questionCount,
        resource,
        task
    ) {
        const total =
            Math.max(
                MIN_ASSESSMENT_QUESTIONS,

                Math.min(
                    MAX_ASSESSMENT_QUESTIONS,

                    Number(
                        questionCount
                    ) ||
                    MIN_ASSESSMENT_QUESTIONS
                )
            );

        const batchSizes = [];

        let remaining =
            total;

        while (
            remaining >
            0
        ) {
            const size =
                Math.min(
                    ASSESSMENT_BATCH_SIZE,
                    remaining
                );

            batchSizes.push(
                size
            );

            remaining -=
                size;
        }

        const results =
            new Array(
                batchSizes.length
            );

        let nextBatch =
            0;

        async function worker() {
            while (
                nextBatch <
                batchSizes.length
            ) {
                const batchIndex =
                    nextBatch++;

                const excerpt =
                    sliceResourceForAssessment(
                        resourceText,
                        batchIndex,
                        batchSizes.length
                    );

                results[
                    batchIndex
                ] =
                    await generateAssessmentQuestionBatch(
                        excerpt,
                        batchSizes[
                        batchIndex
                        ],
                        resource,
                        task,
                        batchIndex,
                        batchSizes.length
                    );
            }
        }

        const workerCount =
            Math.min(
                ASSESSMENT_BATCH_CONCURRENCY,
                batchSizes.length
            );

        await Promise.all(
            Array.from(
                {
                    length:
                        workerCount
                },
                () =>
                    worker()
            )
        );

        const questions =
            results
                .flat()
                .slice(
                    0,
                    total
                );

        if (
            questions.length !==
            total
        ) {
            throw new Error(
                "The generated quiz was incomplete."
            );
        }

        return questions;
    }

    function buildAlignmentContext(
        resourceText,
        maxChars = 14000
    ) {
        const text =
            String(
                resourceText ||
                ""
            ).trim();

        if (
            text.length <=
            maxChars
        ) {
            return text;
        }

        const part =
            Math.floor(
                maxChars /
                3
            );

        const middleStart =
            Math.max(
                0,

                Math.floor(
                    text.length /
                    2 -
                    part /
                    2
                )
            );

        return [
            text.slice(
                0,
                part
            ),

            text.slice(
                middleStart,
                middleStart +
                part
            ),

            text.slice(
                -part
            )
        ].join(
            "\n\n[...additional resource content omitted for fast summary verification...]\n\n"
        );
    }

    async function checkSummaryAlignment(
        summary,
        resource,
        task,
        resourceText
    ) {
        const alignmentContext =
            buildAlignmentContext(
                resourceText
            );

        const prompt =
            `You are evaluating whether a university student's short study summary demonstrates genuine understanding of the topic they just studied.

This is NOT a plagiarism check.
This is NOT a keyword-matching exercise.
This is NOT a test of whether the student remembers every detail.

RESOURCE TITLE:
${resource?.title || task?.title || "Study resource"}

RESOURCE CONTEXT:
${alignmentContext}

STUDENT SUMMARY:
${summary}

Return ONLY valid JSON with this exact structure and nothing else:

{"aligned":true,"alignmentScore":0,"feedback":"brief evidence-based feedback"}

Rules:

- Judge conceptual understanding, not textual similarity.
- The student does not need to copy wording, use the exact terminology, follow the same order, mention every detail, or reproduce examples.
- The student may explain the topic in their own words.
- The student may simplify an idea accurately.
- The student may use their own examples.
- The student may paraphrase.
- The student may connect the material to accurate related knowledge.
- A concise but accurate explanation can demonstrate understanding.
- Mark aligned=false only when the summary is substantially off-topic, meaningfully factually incorrect, contradictory to the central subject, meaningless/repetitive, or so vague that it demonstrates no real understanding.
- Generic statements such as "I studied this topic and it was interesting" should fail because they do not demonstrate understanding.
- alignmentScore must measure the quality and depth of demonstrated conceptual understanding, not wording similarity.
- aligned should be true only when alignmentScore is at least 60.
- Keep feedback to one short sentence where possible and never more than two short sentences.
- Do NOT generate assessment questions here.
- Return the JSON object immediately with no Markdown or extra commentary.`;

        const response =
            await askGemini(
                prompt,
                {
                    mode:
                        "alignment"
                }
            );

        if (!response) {
            throw new Error(
                "The summary check could not be completed."
            );
        }

        const parsed =
            parseJsonObjectFromAi(
                response
            );

        const alignmentScore =
            Math.max(
                0,
                Math.min(
                    100,
                    Number(
                        parsed?.alignmentScore
                    ) ||
                    0
                )
            );

        return {
            aligned:
                parsed?.aligned ===
                true &&
                alignmentScore >=
                60,

            alignmentScore,

            feedback:
                String(
                    parsed?.feedback ||
                    ""
                )
        };
    }

    // -------------------------------------------------------------
    // SILENT BACKGROUND QUESTION GENERATION
    // -------------------------------------------------------------

    function startBackgroundAssessmentPrep(
        resource,
        task
    ) {
        if (!resource) {
            timer.backgroundPrep =
                null;

            return;
        }

        const resourceId =
            resource.id;

        const resourceTextPromise =
            extractResourceStudyText(
                resource
            );

        const questionsPromise =
            resourceTextPromise.then(
                async resourceText => {
                    if (
                        !resourceText ||
                        resourceText
                            .trim()
                            .length <
                        30
                    ) {
                        return {
                            questionCount:
                                0,

                            questions:
                                null
                        };
                    }

                    const questionCount =
                        computeQuestionCount(
                            resourceText
                        );

                    try {
                        const questions =
                            await generateAssessmentQuestions(
                                resourceText,
                                questionCount,
                                resource,
                                task
                            );

                        return {
                            questionCount,
                            questions
                        };

                    } catch (error) {
                        console.warn(
                            "Background quiz generation failed — falling back to post-summary generation.",
                            error
                        );

                        return {
                            questionCount,

                            questions:
                                null
                        };
                    }
                }
            );

        timer.backgroundPrep = {
            resourceId,
            resourceTextPromise,
            questionsPromise
        };
    }

    function renderAssessment(
        assessment
    ) {
        els.assessmentSummaryStatus.className =
            `assessment-summary-status ${assessment.aligned
                ? "match"
                : "mismatch"
            }`;

        els.assessmentSummaryStatus.innerHTML =
            `<strong>${assessment.aligned
                ? "Summary confirmed"
                : "Summary needs correction"
            } — ${assessment.alignmentScore}% alignment</strong><p>${escapeHtml(
                assessment.feedback
            )}</p>`;

        const countNote =
            document.getElementById(
                "assessmentQuestionCountNote"
            );

        if (
            countNote
        ) {
            countNote.textContent =
                `Answer ${assessment.objectiveQuestions.length} university-level questions, generated from the material you've read so far.`;
        }

        els.objectiveQuestions.innerHTML =
            assessment.objectiveQuestions
                .map(
                    (
                        item,
                        index
                    ) => `
<fieldset class="assessment-question">
<legend>
${index + 1}.
${escapeHtml(
                        item.question
                    )}
</legend>

${item.options
                            .map(
                                (
                                    option,
                                    optionIndex
                                ) => `
<label class="assessment-option">

<input
type="radio"
name="objective-${index}"
value="${optionIndex}"
>

<span>
${escapeHtml(
                                    option
                                )}
</span>

</label>
`
                            )
                            .join("")
                        }

</fieldset>
`
                )
                .join("");

        els.assessmentValidation.textContent =
            "";
    }
async function saveReflection() {
    if (
        !timer.pendingCompletion ||
        els.saveReflection.disabled
    ) {
        return;
    }

    const task =
        state.tasks.find(
            item =>
                item.id ===
                timer.pendingCompletion.taskId
        );

    const resourceId =
        task?.resourceId ||
        timer.pendingCompletion.resourceId;

    const resource =
        resourceId
            ? getResource(
                resourceId
            )
            : null;

    const summary =
        els.reflectionText.value.trim();

    if (!resource) {
        showToast(
            "Link a study resource to this task before the summary can be verified.",
            "error"
        );
        return;
    }

    els.saveReflection.disabled =
        true;

    els.saveReflection.textContent =
        "Checking summary…";

    els.reflectionAlignment.className =
        "alignment-status visible";

    els.reflectionAlignment.textContent =
        "Checking your understanding of the topic…";

    try {
        const bg =
            timer.backgroundPrep &&
                timer.backgroundPrep.resourceId ===
                resource.id
                ? timer.backgroundPrep
                : null;

        /*
        * We only wait for resource extraction here.
        * Quiz generation continues independently.
        */
        const resourceText =
            bg
                ? await bg.resourceTextPromise
                : await extractResourceStudyText(
                    resource
                );

        if (
            !resourceText ||
            resourceText
                .trim()
                .length <
            30
        ) {
            throw new Error(
                "There is not enough readable resource content to verify the summary. Add detailed resource notes or upload a readable PDF/text file."
            );
        }

        /*
        * Summary verification happens immediately.
        */
        const alignment =
            await checkSummaryAlignment(
                summary,
                resource,
                task,
                resourceText
            );

        if (!alignment.aligned) {
            els.reflectionAlignment.className =
                "alignment-status visible mismatch";

            els.reflectionAlignment.textContent =
                `${alignment.feedback} Alignment score: ${alignment.alignmentScore}%. Revise the summary before continuing.`;

            return;
        }

        /*
        * The summary is valid at this point.
        *
        * Quiz-generation failure must never be reported
        * as summary-verification failure.
        */
        let questionCount =
            computeQuestionCount(
                resourceText
            );

        let questions =
            null;

        if (bg) {
            try {
                const prepared =
                    await bg.questionsPromise;

                if (prepared) {
                    questionCount =
                        prepared.questionCount ||
                        questionCount;

                    questions =
                        prepared.questions ||
                        null;
                }

            } catch (error) {
                console.warn(
                    "Background assessment preparation failed. Using fallback generation.",
                    error
                );

                questions =
                    null;
            }
        }

        if (!questions) {
            els.reflectionAlignment.className =
                "alignment-status visible match";

            els.reflectionAlignment.textContent =
                "Summary confirmed. Preparing your assessment…";

            try {
                questions =
                    await generateAssessmentQuestions(
                        resourceText,
                        questionCount,
                        resource,
                        task
                    );

            } catch (error) {
                console.error(
                    "Assessment generation failed after summary was accepted.",
                    error
                );

                /*
                * The reflection has already passed.
                * Do not tell the student the reflection failed.
                */
                els.reflectionAlignment.className =
                    "alignment-status visible mismatch";

                els.reflectionAlignment.textContent =
                    "Your summary was accepted, but the assessment could not be prepared. Please click Continue again to retry.";

                return;
            }
        }

        /*
        * Final question cap.
        */
        questions =
            questions.slice(
                0,
                MAX_ASSESSMENT_QUESTIONS
            );

        const assessment = {
            aligned:
                alignment.aligned,

            alignmentScore:
                alignment.alignmentScore,

            feedback:
                alignment.feedback,

            objectiveQuestions:
                questions
        };

        timer.pendingAssessment = {
            assessment,
            summary,

            resourceId:
                resource.id
        };

        timer.backgroundPrep =
            null;

        renderAssessment(
            assessment
        );

        closeModal(
            els.reflectionModal
        );

        openModal(
            els.assessmentModal
        );

    } catch (error) {
        console.error(
            "Reflection verification failed:",
            error
        );

        els.reflectionAlignment.className =
            "alignment-status visible mismatch";

        els.reflectionAlignment.textContent =
            describeAiError(
                error
            );

    } finally {
        els.saveReflection.textContent =
            "Check summary & continue";

        if (
            typeof validateReflection ===
            "function"
        ) {
            validateReflection();

        } else {
            els.saveReflection.disabled =
                false;
        }
    }
}

// -------------------------------------------------------------
// ASSESSMENT RESULT REVIEW
// -------------------------------------------------------------

function openAssessmentResultsModal(
    assessment,
    objectiveAnswers,
    objectiveScore,
    onContinue
) {
    const backdrop =
        document.createElement(
            "div"
        );

    backdrop.className =
        "modal-backdrop";

    const objectiveHtml =
        assessment.objectiveQuestions
            .map(
                (
                    item,
                    index
                ) => {
                    const selected =
                        objectiveAnswers[
                        index
                        ];

                    const correct =
                        item.correctAnswer;

                    const isCorrect =
                        selected ===
                        correct;

                    const optionsHtml =
                        item.options
                            .map(
                                (
                                    option,
                                    optionIndex
                                ) => {
                                    let marker =
                                        "";

                                    let style =
                                        "";

                                    if (
                                        optionIndex ===
                                        correct
                                    ) {
                                        marker =
                                            "✓ ";

                                        style =
                                            "color:var(--success);font-weight:700;";

                                    } else if (
                                        optionIndex ===
                                        selected
                                    ) {
                                        marker =
                                            "✗ ";

                                        style =
                                            "color:var(--danger);font-weight:700;";
                                    }

                                    return `
<label
class="assessment-option"
style="${style}"
>
<span>
${marker}${escapeHtml(
                                        option
                                    )}
</span>
</label>
`;
                                }
                            )
                            .join("");

                    return `
<fieldset class="assessment-question">
<legend>
${index + 1}.
${escapeHtml(
                        item.question
                    )}

<span
style="
margin-left:8px;
font-weight:800;
color:${isCorrect
                            ? "var(--success)"
                            : "var(--danger)"
                        };
"
>
${isCorrect
                            ? "Correct"
                            : "Incorrect"
                        }
</span>
</legend>

${optionsHtml}

${item.explanation
                            ? `
<p
style="
margin:12px 4px 0;
color:var(--muted);
font-size:.8rem;
line-height:1.55;
"
>
<strong
style="color:var(--text);"
>
Why:
</strong>

${escapeHtml(
                                item.explanation
                            )}
</p>
`
                            : ""
                        }
</fieldset>
`;
                }
            )
            .join("");

    backdrop.innerHTML =
        `
<div class="modal-card assessment-card">
<div class="modal-header">
<div>
<p class="eyebrow">
Session results
</p>

<h3>
Review your answers
</h3>
</div>
</div>

<div class="assessment-summary-status ${objectiveScore >=
            3
            ? "match"
            : "mismatch"
        }">
<strong>
Grade:
${objectiveScore}/${assessment.objectiveQuestions.length}
</strong>

<p>
Go through each question below to see the correct answer and why it's correct.
</p>
</div>

<section class="assessment-section">
<h4>
Objective questions
</h4>

<div class="assessment-question-list">
${objectiveHtml}
</div>
</section>

<div class="modal-actions">
<button
class="primary-button"
id="closeAssessmentResultsButton"
>
Continue
</button>
</div>
</div>
`;

    document.body.appendChild(
        backdrop
    );

    openModal(
        backdrop
    );

    const finish =
        () => {
            closeModal(
                backdrop
            );

            backdrop.remove();

            if (
                typeof onContinue ===
                "function"
            ) {
                onContinue();
            }
        };

    backdrop
        .querySelector(
            "#closeAssessmentResultsButton"
        )
        .addEventListener(
            "click",
            finish
        );

    backdrop.addEventListener(
        "mousedown",
        event => {
            if (
                event.target ===
                backdrop
            ) {
                finish();
            }
        }
    );
}

function submitAssessment(
    event
) {
    event.preventDefault();

    if (
        !timer.pendingCompletion ||
        !timer.pendingAssessment
    ) {
        return;
    }

    const {
        assessment,
        summary,
        resourceId
    } =
        timer.pendingAssessment;

    const objectiveAnswers =
        assessment.objectiveQuestions.map(
            (
                _,
                index
            ) => {
                const selected =
                    els.assessmentForm.querySelector(
                        `input[name="objective-${index}"]:checked`
                    );

                return selected
                    ? Number(
                        selected.value
                    )
                    : null;
            }
        );

    if (
        objectiveAnswers.some(
            answer =>
                answer ===
                null
        )
    ) {
        els.assessmentValidation.textContent =
            `Answer all ${assessment.objectiveQuestions.length} questions before submitting.`;

        return;
    }

    const objectiveScore =
        objectiveAnswers.reduce(
            (
                score,
                answer,
                index
            ) =>
                score +
                (
                    answer ===
                        assessment.objectiveQuestions[
                            index
                        ].correctAnswer
                        ? 1
                        : 0
                ),
            0
        );

    const task =
        state.tasks.find(
            item =>
                item.id ===
                timer.pendingCompletion.taskId
        );

    const session = {
        id:
            crypto.randomUUID(),

        ...timer.pendingCompletion,

        taskTitle:
            task?.title ||
            "General study session",

        resourceId,

        reflection:
            summary,

        summaryAlignmentScore:
            assessment.alignmentScore,

        assessment: {
            objectiveScore,

            objectiveTotal:
                assessment.objectiveQuestions.length,

            objectiveAnswers,

            objectiveQuestions:
                assessment.objectiveQuestions
        },

        integrity:
            timer.pendingCompletion.focusViolations ===
                0 &&
                timer.pendingCompletion.checksFailed ===
                0
                ? "verified"
                : "flagged"
    };

    state.sessions.push(
        session
    );

    if (
        task &&
        task.status ===
        "todo"
    ) {
        task.status =
            "inProgress";
    }

    saveState();

    closeModal(
        els.assessmentModal
    );

    timer.pendingCompletion =
        null;

    timer.pendingAssessment =
        null;

    openAssessmentResultsModal(
        assessment,
        objectiveAnswers,
        objectiveScore,

        () => {
            const nextMode =
                timer.cycle >=
                    state.settings.cyclesBeforeLongBreak
                    ? "longBreak"
                    : "shortBreak";

            if (
                timer.cycle >=
                state.settings.cyclesBeforeLongBreak
            ) {
                timer.cycle =
                    1;

            } else {
                timer.cycle +=
                    1;
            }

            setTimerMode(
                nextMode,
                true
            );

            els.sessionGoal.value =
                "";

            els.goalCount.textContent =
                "0";

            renderAll();

            showToast(
                `Verified session logged. Grade: ${objectiveScore}/${assessment.objectiveQuestions.length}.`
            );
        }
    );
}

function backToReflection() {
    closeModal(
        els.assessmentModal
    );

    openModal(
        els.reflectionModal
    );

    timer.pendingAssessment =
        null;

    validateReflection();
}

function discardSession() {
    if (
        !window.confirm(
            "Discard this completed session without logging it?"
        )
    ) {
        return;
    }

    timer.pendingCompletion =
        null;

    timer.pendingAssessment =
        null;

    timer.backgroundPrep =
        null;

    closeModal(
        els.reflectionModal
    );

    const nextMode =
        timer.cycle >=
            state.settings.cyclesBeforeLongBreak
            ? "longBreak"
            : "shortBreak";

    if (
        timer.cycle >=
        state.settings.cyclesBeforeLongBreak
    ) {
        timer.cycle =
            1;

    } else {
        timer.cycle +=
            1;
    }

    setTimerMode(
        nextMode,
        true
    );

    showToast(
        "Session discarded.",
        "warning"
    );
}

// -------------------------------------------------------------
// PROGRESS
// -------------------------------------------------------------

function renderProgress() {
    const totalMinutes =
        state.sessions.reduce(
            (
                sum,
                session
            ) =>
                sum +
                session.durationMinutes,
            0
        );

    const streaks =
        calculateStreaks();

    const completed =
        state.tasks.filter(
            task =>
                task.status ===
                "done"
        ).length;

    const completionRate =
        state.tasks.length
            ? Math.round(
                (
                    completed /
                    state.tasks.length
                ) *
                100
            )
            : 0;

    const weeklyMinutes =
        getWeeklyMinutes();

    const weeklyPercent =
        Math.min(
            100,

            Math.round(
                (
                    weeklyMinutes /
                    state.settings.weeklyGoalMinutes
                ) *
                100
            )
        );

    els.progressStreak.textContent =
        streaks.current;

    els.longestStreak.textContent =
        streaks.longest;

    els.progressTotalTime.textContent =
        formatMinutes(
            totalMinutes
        );

    els.completionRate.textContent =
        `${completionRate}%`;

    els.weeklyGoalPercent.textContent =
        `${weeklyPercent}%`;

    els.weeklyGoalCaption.textContent =
        `${Math.round(
            weeklyMinutes
        )} of ${state.settings.weeklyGoalMinutes} minutes`;

    els.goalRing.style.setProperty(
        "--goal-progress",
        `${weeklyPercent * 3.6}deg`
    );

    renderBarChart(
        els.progressChart,
        getLastSevenDays(),
        true
    );

    renderHistory();
}

function renderHistory() {
    const sessions = [
        ...state.sessions
    ].sort(
        (
            a,
            b
        ) =>
            b.completedAt -
            a.completedAt
    );

    els.historyBody.innerHTML =
        sessions.length
            ? sessions
                .map(
                    session => `
<tr>
<td>
${formatDate(
                        session.completedAt
                    )}
</td>

<td>
${escapeHtml(
                        session.taskTitle ||
                        "General study session"
                    )}
</td>

<td>
${session.durationMinutes} min
</td>

<td>
<span
class="integrity-badge ${session.integrity ===
                            "verified"
                            ? "integrity-good"
                            : "integrity-flagged"
                        }"
>
${session.integrity ===
                            "verified"
                            ? "Verified"
                            : "Flagged"
                        }
</span>
</td>

<td>
<button
class="text-button"
data-view-reflection="${session.id}"
>
View
</button>

${session.assessment
                            ? `
<button
class="text-button"
data-view-results="${session.id}"
>
Results
</button>
`
                            : ""
                        }
</td>
</tr>
`
                )
                .join("")
            : `
<tr>
<td colspan="5">
<div class="empty-state">
No completed sessions yet.
</div>
</td>
</tr>
`;
}

function viewReflection(
    id
) {
    const session =
        state.sessions.find(
            item =>
                item.id ===
                id
        );

    if (!session) {
        return;
    }

    els.reflectionViewTitle.textContent =
        session.taskTitle ||
        "Session reflection";

    els.reflectionViewText.textContent =
        session.reflection;

    openModal(
        els.reflectionViewModal
    );
}

function viewSessionResults(
    id
) {
    const session =
        state.sessions.find(
            item =>
                item.id ===
                id
        );

    if (
        !session ||
        !session.assessment
    ) {
        return;
    }

    const assessment = {
        objectiveQuestions:
            session.assessment.objectiveQuestions
    };

    openAssessmentResultsModal(
        assessment,

        session.assessment.objectiveAnswers,

        session.assessment.objectiveScore,

        () => { }
    );
}// -------------------------------------------------------------
// SETTINGS
// -------------------------------------------------------------

function populateSettings() {
    els.focusMinutesSetting.value =
        state.settings.focusMinutes;

    els.shortBreakSetting.value =
        state.settings.shortBreakMinutes;

    els.longBreakSetting.value =
        state.settings.longBreakMinutes;

    els.cyclesSetting.value =
        state.settings.cyclesBeforeLongBreak;

    els.weeklyGoalSetting.value =
        state.settings.weeklyGoalMinutes;

    state.settings.focusTracking =
        true;

    state.settings.verificationChecks =
        true;

    state.settings.sound =
        true;

    els.focusTrackingSetting.checked =
        true;

    els.verificationSetting.checked =
        true;

    els.soundSetting.checked =
        true;
}

function saveSettings() {
    const next = {
        focusMinutes:
            Number(
                els.focusMinutesSetting.value
            ),

        shortBreakMinutes:
            Number(
                els.shortBreakSetting.value
            ),

        longBreakMinutes:
            Number(
                els.longBreakSetting.value
            ),

        cyclesBeforeLongBreak:
            Number(
                els.cyclesSetting.value
            ),

        weeklyGoalMinutes:
            Number(
                els.weeklyGoalSetting.value
            ),

        focusTracking:
            true,

        verificationChecks:
            true,

        sound:
            true,

        theme:
            state.settings.theme
    };

    const valid =
        next.focusMinutes >=
        1 &&
        next.focusMinutes <=
        180 &&

        next.shortBreakMinutes >=
        1 &&
        next.shortBreakMinutes <=
        60 &&

        next.longBreakMinutes >=
        1 &&
        next.longBreakMinutes <=
        90 &&

        next.cyclesBeforeLongBreak >=
        1 &&
        next.cyclesBeforeLongBreak <=
        10 &&

        next.weeklyGoalMinutes >=
        30 &&
        next.weeklyGoalMinutes <=
        10080;

    if (!valid) {
        showToast(
            "Please check the timer and weekly goal values.",
            "error"
        );

        return;
    }

    state.settings =
        next;

    saveState();

    if (!timer.running) {
        setTimerMode(
            timer.mode,
            true
        );
    }

    renderAll();

    showToast(
        "Settings saved."
    );
}

async function resetAllData() {
    if (
        !window.confirm(
            "Reset every task, session, and setting stored for this user?"
        )
    ) {
        return;
    }

    if (
        !window.confirm(
            "This cannot be undone. Continue?"
        )
    ) {
        return;
    }

    if (currentUser) {
        localStorage.removeItem(
            getStorageKey(
                currentUser.id
            )
        );
    }

    state =
        structuredClone(
            defaultState
        );

    if (currentUser) {
        try {
            const {
                error
            } =
                await supabase
                    .from(
                        STATE_TABLE
                    )
                    .upsert(
                        {
                            user_id:
                                currentUser.id,

                            data:
                                state,

                            updated_at:
                                new Date().toISOString()
                        },

                        {
                            onConflict:
                                "user_id"
                        }
                    );

            if (error) {
                throw error;
            }

        } catch (error) {
            console.error(
                "Could not reset cloud state.",
                error
            );

            showToast(
                "Local data was reset, but the cloud copy could not be cleared. Try again when you're back online.",
                "error"
            );
        }
    }

    timer.cycle =
        1;

    setTimerMode(
        "focus",
        true
    );

    populateSettings();
    applyTheme();
    renderAll();

    navigate(
        "dashboard"
    );

    showToast(
        "All user app data has been reset.",
        "warning"
    );
}

// -------------------------------------------------------------
// BACKBLAZE B2
// -------------------------------------------------------------

function sanitiseFileName(
    name = "file"
) {
    const cleaned =
        name.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
        );

    return (
        cleaned.slice(
            -140
        ) ||
        "file"
    );
}

function resourceStoragePath(
    userId,
    id,
    fileName
) {
    return `${userId}/${id}-${sanitiseFileName(
        fileName
    )}`;
}

const MAX_FILE_SIZE_BYTES =
    50 *
    1024 *
    1024;

async function b2Presign(
    action,
    payload
) {
    const {
        data,
        error
    } =
        await supabase.functions.invoke(
            "b2-presign",
            {
                body: {
                    action,
                    ...payload
                }
            }
        );

    if (error) {
        let detail =
            "";

        try {
            const context =
                error.context;

            if (
                context &&
                typeof context.json ===
                "function"
            ) {
                const body =
                    await context.json();

                detail =
                    body?.error ||
                    "";
            }

        } catch (_) {
        }

        throw new Error(
            detail ||
            error.message ||
            "Could not reach file storage."
        );
    }

    if (
        data &&
        data.error
    ) {
        throw new Error(
            data.error
        );
    }

    return data;
}

async function uploadResourceFile(
    id,
    file,
    onProgress
) {
    if (!currentUser) {
        throw new Error(
            "You must be signed in to upload a resource."
        );
    }

    const {
        url
    } =
        await b2Presign(
            "upload",
            {
                resourceId:
                    id,

                fileName:
                    file.name
            }
        );

    await new Promise(
        (
            resolve,
            reject
        ) => {
            const xhr =
                new XMLHttpRequest();

            xhr.open(
                "PUT",
                url,
                true
            );

            xhr.setRequestHeader(
                "Content-Type",
                file.type ||
                "application/octet-stream"
            );

            if (
                xhr.upload &&
                typeof onProgress ===
                "function"
            ) {
                xhr.upload.addEventListener(
                    "progress",
                    event => {
                        if (
                            event.lengthComputable
                        ) {
                            onProgress(
                                Math.round(
                                    (
                                        event.loaded /
                                        event.total
                                    ) *
                                    100
                                )
                            );
                        }
                    }
                );
            }

            xhr.onload =
                () => {
                    if (
                        xhr.status >=
                        200 &&
                        xhr.status <
                        300
                    ) {
                        resolve();

                    } else {
                        reject(
                            new Error(
                                `Upload failed (status ${xhr.status}). Check your connection and try again.`
                            )
                        );
                    }
                };

            xhr.onerror =
                () =>
                    reject(
                        new Error(
                            "Upload failed. Check your connection and try again."
                        )
                    );

            xhr.send(
                file
            );
        }
    );

    const path =
        resourceStoragePath(
            currentUser.id,
            id,
            file.name
        );

    return {
        storagePath:
            path,

        storageProvider:
            "b2"
    };
}

async function getResourceFileBlob(
    resource
) {
    if (
        !resource?.storagePath
    ) {
        return null;
    }

    try {
        if (
            resource.storageProvider ===
            "b2"
        ) {
            const {
                url
            } =
                await b2Presign(
                    "download",
                    {
                        path:
                            resource.storagePath
                    }
                );

            const response =
                await fetch(
                    url
                );

            if (!response.ok) {
                throw new Error(
                    `Download failed (status ${response.status}).`
                );
            }

            return await response.blob();
        }

        const {
            data,
            error
        } =
            await supabase.storage
                .from(
                    RESOURCE_BUCKET
                )
                .download(
                    resource.storagePath
                );

        if (error) {
            throw error;
        }

        return data;

    } catch (error) {
        console.warn(
            "Could not download resource file from cloud storage.",
            error
        );

        return null;
    }
}

async function removeResourceFile(
    resource
) {
    if (
        !resource?.storagePath
    ) {
        return;
    }

    try {
        if (
            resource.storageProvider ===
            "b2"
        ) {
            await b2Presign(
                "delete",
                {
                    path:
                        resource.storagePath
                }
            );

        } else {
            const {
                error
            } =
                await supabase.storage
                    .from(
                        RESOURCE_BUCKET
                    )
                    .remove([
                        resource.storagePath
                    ]);

            if (error) {
                throw error;
            }
        }

    } catch (error) {
        console.warn(
            "Could not remove resource file from cloud storage.",
            error
        );
    }
}

async function migrateResourcesToB2() {
    if (!currentUser) {
        return;
    }

    const legacyResources =
        state.resources.filter(
            r =>
                r.storagePath &&
                r.storageProvider !==
                "b2"
        );

    if (
        !legacyResources.length
    ) {
        showToast(
            "No resources need migrating — everything is already on Backblaze B2."
        );

        return;
    }

    if (
        !window.confirm(
            `Migrate ${legacyResources.length} file(s) from Supabase Storage to Backblaze B2? This may take a while depending on file sizes.`
        )
    ) {
        return;
    }

    let migrated = 0;
    let failed = 0;

    for (
        const resource of
        legacyResources
    ) {
        try {
            const {
                data: file,
                error: downloadError
            } =
                await supabase.storage
                    .from(
                        RESOURCE_BUCKET
                    )
                    .download(
                        resource.storagePath
                    );

            if (
                downloadError ||
                !file
            ) {
                throw (
                    downloadError ||
                    new Error(
                        "Empty file"
                    )
                );
            }

            const fileForUpload =
                new File(
                    [
                        file
                    ],

                    resource.fileName ||
                    "file",

                    {
                        type:
                            resource.mimeType ||
                            file.type ||
                            "application/octet-stream"
                    }
                );

            const {
                storagePath,
                storageProvider
            } =
                await uploadResourceFile(
                    resource.id,
                    fileForUpload
                );

            await supabase.storage
                .from(
                    RESOURCE_BUCKET
                )
                .remove([
                    resource.storagePath
                ]);

            resource.storagePath =
                storagePath;

            resource.storageProvider =
                storageProvider;

            migrated += 1;

        } catch (error) {
            console.error(
                `Could not migrate resource "${resource.title}".`,
                error
            );

            failed += 1;
        }
    }

    saveState();
    renderAll();

    if (failed) {
        showToast(
            `Migrated ${migrated} file(s) to B2. ${failed} failed and remain on Supabase Storage — try again later.`,
            "warning"
        );

    } else {
        showToast(
            `All ${migrated} file(s) migrated to Backblaze B2.`
        );
    }
}

function getResource(id) {
    return state.resources.find(
        item =>
            item.id ===
            id
    );
}

function toggleResourceFields() {
    const isLink =
        els.resourceKind.value ===
        "link";

    els.resourceFileGroup.classList.toggle(
        "hidden",
        isLink
    );

    els.resourceUrlGroup.classList.toggle(
        "hidden",
        !isLink
    );
}

function fileKindLabel(
    file
) {
    const type =
        file.type ||
        "";

    if (
        type.startsWith(
            "video/"
        )
    ) {
        return {
            icon:
                "🎬",

            label:
                "Video selected"
        };
    }

    if (
        type.startsWith(
            "audio/"
        )
    ) {
        return {
            icon:
                "🎧",

            label:
                "Audio selected"
        };
    }

    if (
        type.startsWith(
            "image/"
        )
    ) {
        return {
            icon:
                "🖼️",

            label:
                "Image selected"
        };
    }

    if (
        type ===
        "application/pdf"
    ) {
        return {
            icon:
                "📄",

            label:
                "PDF selected"
        };
    }

    if (
        type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        /\.docx$/i.test(
            file.name ||
            ""
        )
    ) {
        return {
            icon:
                "📝",

            label:
                "Word document selected"
        };
    }

    return {
        icon:
            "📄",

        label:
            "File selected"
    };
}

function updateFileDropDisplay() {
    if (
        !els.resourceFileDrop
    ) {
        return;
    }

    const file =
        els.resourceFile.files[0];

    if (!file) {
        els.resourceFileDrop.classList.remove(
            "has-file"
        );

        els.resourceFileIcon.textContent =
            "📎";

        els.resourceFileLabel.textContent =
            "Choose a document or video";

        els.resourceFileName.textContent =
            "No file chosen";

        return;
    }

    const {
        icon,
        label
    } =
        fileKindLabel(
            file
        );

    els.resourceFileDrop.classList.add(
        "has-file"
    );

    els.resourceFileIcon.textContent =
        icon;

    els.resourceFileLabel.textContent =
        label;

    els.resourceFileName.textContent =
        `${file.name} · ${humanFileSize(
            file.size
        )}`;
}

function clearFileDrop() {
    els.resourceFile.value =
        "";

    updateFileDropDisplay();
}

function bindFileDropEvents() {
    if (
        !els.resourceFileDrop
    ) {
        return;
    }

    els.resourceFile.addEventListener(
        "change",
        updateFileDropDisplay
    );

    els.resourceFileClear.addEventListener(
        "click",
        event => {
            event.preventDefault();
            event.stopPropagation();

            clearFileDrop();
        }
    );
}

async function saveResource(
    event
) {
    event.preventDefault();

    const kind =
        els.resourceKind.value;

    const file =
        els.resourceFile.files[0];

    const url =
        els.resourceUrl.value.trim();

    if (
        kind ===
        "file" &&
        !file
    ) {
        showToast(
            "Choose a document or video to upload.",
            "error"
        );

        return;
    }

    if (
        kind ===
        "link" &&
        !url
    ) {
        showToast(
            "Enter a valid resource URL.",
            "error"
        );

        return;
    }

    const id =
        crypto.randomUUID();

    let type =
        "link";

    let mimeType =
        "";

    let fileName =
        "";

    let fileSize =
        0;

    let storagePath =
        "";

    let storageProvider =
        "";

    if (file) {
        if (
            file.size >
            MAX_FILE_SIZE_BYTES
        ) {
            showToast(
                `"${file.name}" is ${humanFileSize(
                    file.size
                )} — the study library's free-tier limit is 50 MB per file. Try a shorter/compressed video, or use a YouTube link instead.`,
                "error"
            );

            return;
        }

        mimeType =
            file.type ||
            "application/octet-stream";

        fileName =
            file.name;

        fileSize =
            file.size;

        type =
            mimeType.startsWith(
                "video/"
            ) ||
                mimeType.startsWith(
                    "audio/"
                )
                ? "video"
                : "document";

        const submitButton =
            els.resourceSubmitButton;

        const originalLabel =
            submitButton
                ? submitButton.textContent
                : "";

        if (submitButton) {
            submitButton.disabled =
                true;
        }

        try {
            const uploadResult =
                await uploadResourceFile(
                    id,
                    file,

                    percent => {
                        if (submitButton) {
                            submitButton.textContent =
                                `Uploading… ${percent}%`;
                        }
                    }
                );

            storagePath =
                uploadResult.storagePath;

            storageProvider =
                uploadResult.storageProvider;

        } catch (error) {
            console.error(
                error
            );

            showToast(
                "This file could not be uploaded to your cloud library. Check your connection and try again.",
                "error"
            );

            return;

        } finally {
            if (submitButton) {
                submitButton.disabled =
                    false;

                submitButton.textContent =
                    originalLabel;
            }
        }
    }

    state.resources.unshift({
        id,

        title:
            els.resourceTitle.value.trim(),

        type,
        kind,
        url,
        mimeType,
        fileName,
        fileSize,
        storagePath,
        storageProvider,

        notes:
            els.resourceNotes.value.trim(),

        createdAt:
            Date.now()
    });

    saveState();

    closeModal(
        els.resourceModal
    );

    renderAll();

    showToast(
        file
            ? "Resource uploaded to your cloud library — available on every device."
            : "Resource saved to your study library."
    );
}

function resourceIcon(
    resource
) {
    return resource.type ===
        "video"
        ? "🎬"
        : resource.type ===
            "link"
            ? "🔗"
            : "📄";
}

function humanFileSize(
    bytes = 0
) {
    if (!bytes) {
        return "Web resource";
    }

    const units = [
        "B",
        "KB",
        "MB",
        "GB"
    ];

    let i = 0;

    let n =
        bytes;

    while (
        n >= 1024 &&
        i < 3
    ) {
        n /= 1024;
        i += 1;
    }

    return `${n.toFixed(
        i
            ? 1
            : 0
    )} ${units[i]}`;
} function renderResources() {
    const query =
        (
            els.resourceSearch?.value ||
            ""
        )
            .trim()
            .toLowerCase();

    const filter =
        els.resourceTypeFilter?.value ||
        "all";

    const resources =
        state.resources.filter(
            resource =>
                (
                    !query ||
                    `${resource.title} ${resource.notes} ${resource.fileName}`
                        .toLowerCase()
                        .includes(
                            query
                        )
                ) &&
                (
                    filter ===
                    "all" ||
                    resource.type ===
                    filter
                )
        );

    els.documentCount.textContent =
        state.resources.filter(
            r =>
                r.type ===
                "document"
        ).length;

    els.videoCount.textContent =
        state.resources.filter(
            r =>
                r.type ===
                "video"
        ).length;

    els.linkCount.textContent =
        state.resources.filter(
            r =>
                r.type ===
                "link"
        ).length;

    els.resourceGrid.innerHTML =
        resources.length
            ? resources
                .map(
                    resource => {
                        const progress =
                            resource.readProgress;

                        let progressHtml =
                            "";

                        let pct =
                            null;

                        let isComplete =
                            false;

                        if (
                            progress?.kind ===
                            "pdf" &&
                            progress.totalPages
                        ) {
                            pct =
                                Math.round(
                                    (
                                        progress.maxPage /
                                        progress.totalPages
                                    ) *
                                    100
                                );

                            isComplete =
                                progress.maxPage >=
                                progress.totalPages;

                            const label =
                                isComplete
                                    ? `✓ Finished · read all ${progress.totalPages} pages`
                                    : `${pct}% read · furthest page ${progress.maxPage} of ${progress.totalPages}`;

                            progressHtml =
                                `
                                <div class="resource-progress${isComplete
                                    ? " is-complete"
                                    : ""
                                }">
                                    <span
                                        style="width:${pct}%"
                                    ></span>
                                </div>

                                <small class="resource-progress-label">
                                    ${label}
                                </small>
                                `;

                        } else if (
                            (
                                progress?.kind ===
                                "docx" ||
                                progress?.kind ===
                                "text"
                            ) &&
                            typeof progress.maxPercent ===
                            "number"
                        ) {
                            pct =
                                Math.round(
                                    progress.maxPercent *
                                    100
                                );

                            isComplete =
                                progress.maxPercent >=
                                0.999;

                            const label =
                                isComplete
                                    ? "✓ Finished reading"
                                    : `${pct}% read`;

                            progressHtml =
                                `
                                <div class="resource-progress${isComplete
                                    ? " is-complete"
                                    : ""
                                }">
                                    <span
                                        style="width:${pct}%"
                                    ></span>
                                </div>

                                <small class="resource-progress-label">
                                    ${label}
                                </small>
                                `;
                        }

                        const actionLabel =
                            pct ===
                                null
                                ? "Open & study"
                                : isComplete
                                    ? "Review again"
                                    : "Continue studying";

                        return `
                        <article class="resource-card">
                            <div class="resource-card__icon">
                                ${resourceIcon(
                            resource
                        )}
                            </div>

                            <div class="resource-card__content">
                                <span class="resource-type">
                                    ${resource.type}
                                </span>

                                <h3>
                                    ${escapeHtml(
                            resource.title
                        )}
                                </h3>

                                <p>
                                    ${escapeHtml(
                            resource.notes ||
                            resource.fileName ||
                            "Ready to study"
                        )}
                                </p>

                                <small>
                                    ${resource.fileName
                                ? humanFileSize(
                                    resource.fileSize
                                )
                                : "External link"
                            }
                                </small>

                                ${progressHtml}
                            </div>

                            <div class="resource-card__actions">
                                <button
                                    class="primary-button"
                                    data-open-resource="${resource.id}"
                                >
                                    ${actionLabel}
                                </button>

                                <button
                                    class="secondary-button"
                                    data-plan-resource="${resource.id}"
                                >
                                    Plan task
                                </button>

                                <button
                                    class="danger-text-button"
                                    data-delete-resource="${resource.id}"
                                >
                                    Delete
                                </button>
                            </div>
                        </article>
                        `;
                    }
                )
                .join("")
            : `
            <div class="empty-state resource-empty">
                No resources yet. Upload a document, video, or add a learning link.
            </div>
            `;

    populateTaskResources();
}

function populateTaskResources() {
    const current =
        els.taskResource?.value ||
        "";

    if (
        !els.taskResource
    ) {
        return;
    }

    els.taskResource.innerHTML =
        `<option value="">No linked resource</option>${state.resources
            .map(
                r =>
                    `<option value="${r.id}">${escapeHtml(
                        r.title
                    )}</option>`
            )
            .join("")
        }`;

    if (
        state.resources.some(
            r =>
                r.id ===
                current
        )
    ) {
        els.taskResource.value =
            current;
    }
}

function revokeBlobUrl() {
    if (currentBlobUrl) {
        URL.revokeObjectURL(
            currentBlobUrl
        );

        currentBlobUrl =
            null;
    }
}

// -------------------------------------------------------------
// RESOURCE VIEWER
// -------------------------------------------------------------

let activeViewerCleanup =
    null;

function isResourceViewerOpen() {
    return Boolean(
        timer.activeResourceId &&
        els.studyWorkspace &&
        !els.studyWorkspace.classList.contains(
            "hidden"
        )
    );
}

function isTextLikeResource(
    resource
) {
    return (
        resource.mimeType.startsWith(
            "text/"
        ) ||
        /\.(txt|md|csv|json|log)$/i.test(
            resource.fileName ||
            ""
        )
    );
}

function isDocxResource(
    resource
) {
    return (
        resource.mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        /\.docx$/i.test(
            resource.fileName ||
            ""
        )
    );
}

function teardownResourceViewer() {
    if (
        typeof activeViewerCleanup ===
        "function"
    ) {
        try {
            activeViewerCleanup();

        } catch (error) {
            console.warn(
                "Viewer cleanup failed.",
                error
            );
        }
    }

    activeViewerCleanup =
        null;

    revokeBlobUrl();
}

async function openStudyResource(
    id,
    taskId = ""
) {
    const resource =
        getResource(
            id
        );

    if (!resource) {
        showToast(
            "That resource is no longer available.",
            "error"
        );

        return;
    }

    teardownResourceViewer();

    timer.activeResourceId =
        resource.id;

    els.workspaceTitle.textContent =
        resource.title;

    els.workspaceViewer.innerHTML =
        `<div class="viewer-loading">Opening resource…</div>`;

    els.studyWorkspace.classList.remove(
        "hidden"
    );

    navigate(
        "timer"
    );

    els.sessionTask.value =
        taskId ||
        "";

    if (
        resource.kind ===
        "link"
    ) {
        renderLinkViewer(
            resource
        );

        els.studyWorkspace.scrollIntoView({
            behavior:
                "smooth",

            block:
                "start"
        });

        return;
    }

    const file =
        await getResourceFileBlob(
            resource
        );

    if (!file) {
        els.workspaceViewer.innerHTML =
            `
            <div class="empty-state">
                This file could not be loaded from your cloud library. Check your connection and try again.
            </div>
            `;

        els.studyWorkspace.scrollIntoView({
            behavior:
                "smooth",

            block:
                "start"
        });

        return;
    }

    currentBlobUrl =
        URL.createObjectURL(
            file
        );

    try {
        if (
            resource.mimeType ===
            "application/pdf"
        ) {
            await renderPdfViewer(
                resource,
                file
            );

        } else if (
            resource.mimeType.startsWith(
                "image/"
            )
        ) {
            renderImageViewer(
                resource,
                currentBlobUrl
            );

        } else if (
            resource.mimeType.startsWith(
                "video/"
            )
        ) {
            renderVideoViewer(
                resource,
                currentBlobUrl
            );

        } else if (
            resource.mimeType.startsWith(
                "audio/"
            )
        ) {
            renderAudioViewer(
                resource,
                currentBlobUrl
            );

        } else if (
            isDocxResource(
                resource
            )
        ) {
            await renderDocxViewer(
                resource,
                file
            );

        } else if (
            isTextLikeResource(
                resource
            )
        ) {
            await renderTextViewer(
                resource,
                file
            );

        } else {
            renderUnsupportedViewer(
                resource,
                currentBlobUrl,
                false
            );
        }

    } catch (error) {
        console.warn(
            "Resource viewer failed to render — falling back to a download option.",
            error
        );

        renderUnsupportedViewer(
            resource,
            currentBlobUrl,
            true
        );
    }

    els.studyWorkspace.scrollIntoView({
        behavior:
            "smooth",

        block:
            "start"
    });
}

function renderLinkViewer(
    resource
) {
    const safeUrl =
        escapeHtml(
            resource.url
        );

    const videoId =
        extractYoutubeVideoId(
            resource.url
        );

    if (videoId) {
        els.workspaceViewer.innerHTML =
            `<iframe
                src="https://www.youtube.com/embed/${videoId}"
                title="${escapeHtml(
                resource.title
            )}"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowfullscreen
            ></iframe>`;

        return;
    }

    els.workspaceViewer.innerHTML =
        `
        <div class="external-resource">
            <div class="resource-card__icon">
                🔗
            </div>

            <h3>
                ${escapeHtml(
            resource.title
        )}
            </h3>

            <p>
                This is a web link, so it opens on its original website in a new browser tab.
            </p>

            <a
                class="primary-button link-button"
                href="${safeUrl}"
                target="_blank"
                rel="noopener"
            >
                Open link in new tab
            </a>
        </div>
        `;
}

function renderImageViewer(
    resource,
    blobUrl
) {
    els.workspaceViewer.innerHTML =
        `
        <div
            class="image-lightbox"
            id="imageLightbox"
        >
            <div class="image-lightbox__stage">
                <img
                    src="${blobUrl}"
                    alt="${escapeHtml(
            resource.title
        )}"
                    id="lightboxImage"
                    draggable="false"
                >
            </div>

            <div class="viewer-toolbar image-toolbar">
                <button
                    type="button"
                    class="icon-button"
                    id="imageZoomOut"
                    aria-label="Zoom out"
                >
                    −
                </button>

                <span id="imageZoomLevel">
                    100%
                </span>

                <button
                    type="button"
                    class="icon-button"
                    id="imageZoomIn"
                    aria-label="Zoom in"
                >
                    +
                </button>

                <button
                    type="button"
                    class="secondary-button"
                    id="imageZoomReset"
                >
                    Reset
                </button>
            </div>
        </div>
        `;

    activeViewerCleanup =
        attachImageZoom();
}

function attachImageZoom() {
    const stage =
        els.workspaceViewer.querySelector(
            ".image-lightbox__stage"
        );

    const img =
        document.getElementById(
            "lightboxImage"
        );

    const zoomLevelLabel =
        document.getElementById(
            "imageZoomLevel"
        );

    const zoomInButton =
        document.getElementById(
            "imageZoomIn"
        );

    const zoomOutButton =
        document.getElementById(
            "imageZoomOut"
        );

    const zoomResetButton =
        document.getElementById(
            "imageZoomReset"
        );

    if (
        !stage ||
        !img
    ) {
        return null;
    }

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
        img.style.transform =
            `translate(${originX}px, ${originY}px) scale(${scale})`;

        zoomLevelLabel.textContent =
            `${Math.round(
                scale *
                100
            )}%`;

        stage.classList.toggle(
            "zoomed",
            scale > 1
        );
    }

    function setScale(next) {
        scale =
            Math.min(
                4,
                Math.max(
                    1,
                    next
                )
            );

        if (
            scale === 1
        ) {
            originX = 0;
            originY = 0;
        }

        applyTransform();
    }

    function pointerDistance(
        touches
    ) {
        const [
            a,
            b
        ] =
            touches;

        return Math.hypot(
            a.clientX -
            b.clientX,

            a.clientY -
            b.clientY
        );
    }

    function onTouchStart(event) {
        if (
            event.touches.length ===
            2
        ) {
            pinchStartDistance =
                pointerDistance(
                    event.touches
                );

            pinchStartScale =
                scale;

        } else if (
            event.touches.length ===
            1 &&
            scale > 1
        ) {
            isPanning =
                true;

            panStartX =
                event.touches[0].clientX -
                originX;

            panStartY =
                event.touches[0].clientY -
                originY;
        }
    }

    function onTouchMove(event) {
        if (
            event.touches.length ===
            2
        ) {
            event.preventDefault();

            const distance =
                pointerDistance(
                    event.touches
                );

            if (
                pinchStartDistance >
                0
            ) {
                setScale(
                    pinchStartScale *
                    (
                        distance /
                        pinchStartDistance
                    )
                );
            }

        } else if (
            event.touches.length ===
            1 &&
            isPanning
        ) {
            event.preventDefault();

            originX =
                event.touches[0].clientX -
                panStartX;

            originY =
                event.touches[0].clientY -
                panStartY;

            applyTransform();
        }
    }

    function onTouchEnd() {
        isPanning =
            false;

        const now =
            Date.now();

        if (
            now -
            lastTapTime <
            320
        ) {
            setScale(
                scale > 1
                    ? 1
                    : 2
            );
        }

        lastTapTime =
            now;
    }

    stage.addEventListener(
        "touchstart",
        onTouchStart,
        {
            passive:
                true
        }
    );

    stage.addEventListener(
        "touchmove",
        onTouchMove,
        {
            passive:
                false
        }
    );

    stage.addEventListener(
        "touchend",
        onTouchEnd
    );

    zoomInButton.addEventListener(
        "click",
        () =>
            setScale(
                scale +
                0.5
            )
    );

    zoomOutButton.addEventListener(
        "click",
        () =>
            setScale(
                scale -
                0.5
            )
    );

    zoomResetButton.addEventListener(
        "click",
        () =>
            setScale(
                1
            )
    );

    img.addEventListener(
        "dblclick",
        () =>
            setScale(
                scale > 1
                    ? 1
                    : 2
            )
    );

    return () => {
        stage.removeEventListener(
            "touchstart",
            onTouchStart
        );

        stage.removeEventListener(
            "touchmove",
            onTouchMove
        );

        stage.removeEventListener(
            "touchend",
            onTouchEnd
        );
    };
}

function renderVideoViewer(
    resource,
    blobUrl
) {
    els.workspaceViewer.innerHTML =
        `<video
            controls
            playsinline
            webkit-playsinline
            preload="metadata"
            src="${blobUrl}"
        ></video>`;
}

function renderAudioViewer(
    resource,
    blobUrl
) {
    els.workspaceViewer.innerHTML =
        `
        <div class="audio-player-wrap">
            <div class="resource-card__icon">
                🎧
            </div>

            <p>
                ${escapeHtml(
            resource.title
        )}
            </p>

            <audio
                controls
                preload="metadata"
                src="${blobUrl}"
            ></audio>
        </div>
        `;
}

function attachScrollProgressTracking(
    resource,
    container,
    kind
) {
    if (!container) {
        return;
    }

    const saved =
        resource.readProgress?.kind ===
            kind
            ? resource.readProgress
            : null;

    if (
        saved &&
        saved.scrollPercent >
        0
    ) {
        requestAnimationFrame(
            () => {
                const maxScroll =
                    container.scrollHeight -
                    container.clientHeight;

                if (
                    maxScroll >
                    0
                ) {
                    container.scrollTop =
                        maxScroll *
                        saved.scrollPercent;
                }
            }
        );

        const isFinished =
            (
                saved.maxPercent ||
                0
            ) >=
            0.999;

        showToast(
            isFinished
                ? `You've already finished reading "${resource.title}". Reopening where you left off.`
                : `Resuming "${resource.title}" from where you left off.`
        );
    }

    let persistTimeoutId =
        null;

    function onScroll() {
        const maxScroll =
            container.scrollHeight -
            container.clientHeight;

        const percent =
            maxScroll > 0
                ? Math.min(
                    1,
                    container.scrollTop /
                    maxScroll
                )
                : 1;

        const maxPercent =
            Math.max(
                percent,

                resource.readProgress?.maxPercent ||
                0
            );

        resource.readProgress = {
            kind,

            scrollPercent:
                percent,

            maxPercent,

            updatedAt:
                Date.now()
        };

        if (
            persistTimeoutId
        ) {
            clearTimeout(
                persistTimeoutId
            );
        }

        persistTimeoutId =
            setTimeout(
                saveState,
                600
            );
    }

    container.addEventListener(
        "scroll",
        onScroll,
        {
            passive:
                true
        }
    );

    activeViewerCleanup =
        () => {
            container.removeEventListener(
                "scroll",
                onScroll
            );

            if (
                persistTimeoutId
            ) {
                clearTimeout(
                    persistTimeoutId
                );
            }
        };
}

async function renderTextViewer(
    resource,
    file
) {
    const text =
        await file.text();

    els.workspaceViewer.innerHTML =
        `<pre
            class="text-viewer"
            id="textViewerContent"
        >${escapeHtml(
            text
        )}</pre>`;

    attachScrollProgressTracking(
        resource,

        document.getElementById(
            "textViewerContent"
        ),

        "text"
    );
}

async function renderDocxViewer(
    resource,
    file
) {
    if (!window.mammoth) {
        renderUnsupportedViewer(
            resource,
            currentBlobUrl,
            true
        );

        return;
    }

    const arrayBuffer =
        await file.arrayBuffer();

    const result =
        await window.mammoth.convertToHtml({
            arrayBuffer
        });

    els.workspaceViewer.innerHTML =
        `<div
            class="docx-viewer"
            id="docxViewerContent"
        >${result.value}</div>`;

    attachScrollProgressTracking(
        resource,

        document.getElementById(
            "docxViewerContent"
        ),

        "docx"
    );
}

function renderUnsupportedViewer(
    resource,
    blobUrl,
    isFallback
) {
    const message =
        isFallback
            ? "This file couldn't be opened in the built-in viewer."
            : "The Study Companion can't preview this file type directly.";

    const meta = [
        (
            resource.fileName ||
            ""
        )
            .split(
                "."
            )
            .pop()
            ?.toUpperCase() ||
        null,

        resource.fileSize
            ? humanFileSize(
                resource.fileSize
            )
            : null
    ]
        .filter(
            Boolean
        )
        .join(
            " · "
        );

    els.workspaceViewer.innerHTML =
        `
        <div class="external-resource">
            <div class="resource-card__icon">
                📄
            </div>

            <h3>
                ${escapeHtml(
            resource.fileName ||
            resource.title
        )}
            </h3>

            ${meta
            ? `
                <p class="external-resource__meta">
                    ${escapeHtml(
                meta
            )}
                </p>
                `
            : ""
        }

            <p>
                ${message}
                You can download it or open it in another app instead.
            </p>

            <a
                class="primary-button link-button"
                href="${blobUrl}"
                download="${escapeHtml(
            resource.fileName ||
            resource.title
        )}"
                target="_blank"
                rel="noopener"
            >
                Download / open externally
            </a>
        </div>
        `;
} async function renderPdfViewer(
    resource,
    file
) {
    if (!window.pdfjsLib) {
        renderUnsupportedViewer(
            resource,
            currentBlobUrl,
            true
        );

        return;
    }

    const bytes =
        new Uint8Array(
            await file.arrayBuffer()
        );

    const pdf =
        await window.pdfjsLib
            .getDocument({
                data:
                    bytes
            })
            .promise;

    const savedProgress =
        resource.readProgress?.kind ===
            "pdf"
            ? resource.readProgress
            : null;

    const startPage =
        savedProgress &&
            savedProgress.lastPage >=
            1 &&
            savedProgress.lastPage <=
            pdf.numPages
            ? savedProgress.lastPage
            : 1;

    els.workspaceViewer.innerHTML =
        `
        <div
            class="pdf-viewer"
            id="pdfViewer"
        >
            <div class="viewer-toolbar pdf-toolbar">
                <button
                    type="button"
                    class="icon-button"
                    id="pdfPrevPage"
                    aria-label="Previous page"
                >
                    ‹
                </button>

                <span id="pdfPageIndicator">
                    Page 1 of ${pdf.numPages}
                </span>

                <button
                    type="button"
                    class="icon-button"
                    id="pdfNextPage"
                    aria-label="Next page"
                >
                    ›
                </button>

                <span class="pdf-toolbar__spacer"></span>

                <span
                    class="pdf-progress-label"
                    id="pdfProgressLabel"
                ></span>

                <button
                    type="button"
                    class="icon-button"
                    id="pdfZoomOut"
                    aria-label="Zoom out"
                >
                    −
                </button>

                <span id="pdfZoomLevel">
                    100%
                </span>

                <button
                    type="button"
                    class="icon-button"
                    id="pdfZoomIn"
                    aria-label="Zoom in"
                >
                    +
                </button>
            </div>

            <div
                class="pdf-canvas-scroll"
                id="pdfCanvasScroll"
            >
                <canvas id="pdfCanvas"></canvas>
            </div>
        </div>
        `;

    const canvas =
        document.getElementById(
            "pdfCanvas"
        );

    const scrollArea =
        document.getElementById(
            "pdfCanvasScroll"
        );

    const pageIndicator =
        document.getElementById(
            "pdfPageIndicator"
        );

    const zoomLevelLabel =
        document.getElementById(
            "pdfZoomLevel"
        );

    const progressLabel =
        document.getElementById(
            "pdfProgressLabel"
        );

    let pageNumber =
        startPage;

    let zoom =
        1;

    let renderTask =
        null;

    let destroyed =
        false;

    function persistReadProgress() {
        const maxPage =
            Math.max(
                pageNumber,

                resource.readProgress?.maxPage ||
                0
            );

        resource.readProgress = {
            kind:
                "pdf",

            lastPage:
                pageNumber,

            maxPage,

            totalPages:
                pdf.numPages,

            updatedAt:
                Date.now()
        };

        saveState();

        if (progressLabel) {
            progressLabel.textContent =
                `Furthest read: page ${maxPage} of ${pdf.numPages}`;
        }
    }

    async function renderPage() {
        if (destroyed) {
            return;
        }

        const page =
            await pdf.getPage(
                pageNumber
            );

        const baseViewport =
            page.getViewport({
                scale:
                    1
            });

        const fitScale =
            Math.max(
                0.2,

                (
                    scrollArea.clientWidth -
                    24
                ) /
                baseViewport.width
            );

        const viewport =
            page.getViewport({
                scale:
                    fitScale *
                    zoom
            });

        canvas.width =
            Math.floor(
                viewport.width
            );

        canvas.height =
            Math.floor(
                viewport.height
            );

        if (renderTask) {
            renderTask.cancel();
        }

        const context =
            canvas.getContext(
                "2d"
            );

        renderTask =
            page.render({
                canvasContext:
                    context,

                viewport
            });

        try {
            await renderTask.promise;

        } catch (error) {
            if (
                error?.name !==
                "RenderingCancelledException"
            ) {
                throw error;
            }
        }

        pageIndicator.textContent =
            `Page ${pageNumber} of ${pdf.numPages}`;

        zoomLevelLabel.textContent =
            `${Math.round(
                zoom *
                100
            )}%`;

        persistReadProgress();
    }

    document
        .getElementById(
            "pdfPrevPage"
        )
        .addEventListener(
            "click",
            () => {
                if (
                    pageNumber >
                    1
                ) {
                    pageNumber -=
                        1;

                    renderPage();
                }
            }
        );

    document
        .getElementById(
            "pdfNextPage"
        )
        .addEventListener(
            "click",
            () => {
                if (
                    pageNumber <
                    pdf.numPages
                ) {
                    pageNumber +=
                        1;

                    renderPage();
                }
            }
        );

    document
        .getElementById(
            "pdfZoomIn"
        )
        .addEventListener(
            "click",
            () => {
                zoom =
                    Math.min(
                        3,

                        zoom +
                        0.25
                    );

                renderPage();
            }
        );

    document
        .getElementById(
            "pdfZoomOut"
        )
        .addEventListener(
            "click",
            () => {
                zoom =
                    Math.max(
                        0.5,

                        zoom -
                        0.25
                    );

                renderPage();
            }
        );

    await renderPage();

    if (
        startPage >
        1
    ) {
        const isFinished =
            (
                savedProgress?.maxPage ||
                0
            ) >=
            pdf.numPages;

        showToast(
            isFinished
                ? `You've already read all ${pdf.numPages} pages of "${resource.title}". Reopening at page ${startPage}.`
                : `Resuming "${resource.title}" from page ${startPage}.`
        );
    }

    activeViewerCleanup =
        () => {
            destroyed =
                true;

            if (renderTask) {
                renderTask.cancel();
            }

            pdf.destroy?.();
        };
}

function closeStudyWorkspace() {
    els.studyWorkspace.classList.remove(
        "workspace-fullscreen"
    );

    els.studyWorkspace.classList.add(
        "hidden"
    );

    els.workspaceViewer.innerHTML =
        "";

    timer.activeResourceId =
        null;

    teardownResourceViewer();
}

function toggleWorkspaceFullscreen() {
    const isFullscreen =
        els.studyWorkspace.classList.toggle(
            "workspace-fullscreen"
        );

    if (
        els.toggleWorkspaceFullscreen
    ) {
        els.toggleWorkspaceFullscreen.textContent =
            isFullscreen
                ? "⤡ Exit full screen"
                : "⤢ Full screen";
    }
}

function planResourceTask(id) {
    const resource =
        getResource(
            id
        );

    if (!resource) {
        return;
    }

    openTaskEditor({
        title:
            `Study: ${resource.title}`,

        description:
            resource.notes ||
            `Study ${resource.title}`,

        priority:
            "medium",

        dueDate:
            "",

        status:
            "todo",

        resourceId:
            id
    });
}

function startTaskStudy(id) {
    const task =
        state.tasks.find(
            t =>
                t.id ===
                id
        );

    if (
        !task?.resourceId
    ) {
        return;
    }

    if (
        task.status ===
        "todo"
    ) {
        task.status =
            "inProgress";
    }

    saveState();

    renderTasks();

    openStudyResource(
        task.resourceId,
        task.id
    );
}

async function deleteResource(id) {
    const resource =
        getResource(
            id
        );

    if (
        !resource ||
        !window.confirm(
            `Delete "${resource.title}" from your library?`
        )
    ) {
        return;
    }

    await removeResourceFile(
        resource
    );

    state.resources =
        state.resources.filter(
            r =>
                r.id !==
                id
        );

    state.tasks.forEach(
        t => {
            if (
                t.resourceId ===
                id
            ) {
                t.resourceId =
                    "";
            }
        }
    );

    saveState();

    renderAll();

    showToast(
        "Resource deleted.",
        "warning"
    );
}

// -------------------------------------------------------------
// PROFILE
// -------------------------------------------------------------

function initials(
    name = "Student"
) {
    return (
        name
            .split(
                /\s+/
            )
            .filter(
                Boolean
            )
            .slice(
                0,
                2
            )
            .map(
                part =>
                    part[0]
            )
            .join("")
            .toUpperCase() ||
        "ST"
    );
}

function applyAvatar(
    element,
    profile,
    large = false
) {
    const init =
        initials(
            profile.name
        );

    element.textContent =
        profile.photo
            ? ""
            : init;

    element.style.backgroundImage =
        profile.photo
            ? `url("${profile.photo}")`
            : "";

    element.classList.toggle(
        "has-photo",

        Boolean(
            profile.photo
        )
    );

    if (large) {
        element.setAttribute(
            "aria-label",

            profile.photo
                ? `${profile.name || "Student"} profile picture`
                : `${init} avatar`
        );
    }
}

function renderProfile() {
    const p =
        state.profile;

    const has =
        Boolean(
            p.name
        );

    applyAvatar(
        els.profileShortcut,
        p
    );

    applyAvatar(
        els.profileAvatarLarge,
        p,
        true
    );

    els.removeProfilePhoto.classList.toggle(
        "hidden",
        !p.photo
    );

    els.profileDisplayName.textContent =
        has
            ? p.name
            : "Create your student profile";

    els.profileDisplayMeta.textContent =
        has
            ? [
                p.course,
                p.department,
                p.level,
                p.school
            ]
                .filter(
                    Boolean
                )
                .join(
                    " • "
                ) ||
            p.email
            : "Add your details to personalise your study experience.";

    els.profileName.value =
        p.name ||
        "";

    els.profileEmail.value =
        p.email ||
        "";

    els.profileSchool.value =
        p.school ||
        "";

    els.profileCourse.value =
        p.course ||
        "";

    els.profileDepartment.value =
        p.department ||
        "";

    els.profileLevel.value =
        p.level ||
        "";

    els.profileBio.value =
        p.bio ||
        "";

    els.profileResourceCount.textContent =
        state.resources.length;

    els.profileTaskCount.textContent =
        state.tasks.length;

    els.profileSessionCount.textContent =
        state.sessions.length;
}

function saveProfile(event) {
    event.preventDefault();

    state.profile = {
        ...state.profile,

        name:
            els.profileName.value.trim(),

        email:
            els.profileEmail.value.trim(),

        school:
            els.profileSchool.value.trim(),

        course:
            els.profileCourse.value.trim(),

        department:
            els.profileDepartment.value.trim(),

        level:
            els.profileLevel.value.trim(),

        bio:
            els.profileBio.value.trim()
    };

    saveState();

    renderProfile();

    showToast(
        "Student profile saved."
    );
}

function resizeProfilePhoto(
    file
) {
    return new Promise(
        (
            resolve,
            reject
        ) => {
            const reader =
                new FileReader();

            reader.onerror =
                () =>
                    reject(
                        new Error(
                            "Could not read image"
                        )
                    );

            reader.onload =
                () => {
                    const image =
                        new Image();

                    image.onerror =
                        () =>
                            reject(
                                new Error(
                                    "Invalid image"
                                )
                            );

                    image.onload =
                        () => {
                            const max =
                                640;

                            const scale =
                                Math.min(
                                    1,

                                    max /
                                    Math.max(
                                        image.width,
                                        image.height
                                    )
                                );

                            const canvas =
                                document.createElement(
                                    "canvas"
                                );

                            canvas.width =
                                Math.round(
                                    image.width *
                                    scale
                                );

                            canvas.height =
                                Math.round(
                                    image.height *
                                    scale
                                );

                            const ctx =
                                canvas.getContext(
                                    "2d"
                                );

                            ctx.drawImage(
                                image,
                                0,
                                0,
                                canvas.width,
                                canvas.height
                            );

                            resolve(
                                canvas.toDataURL(
                                    "image/jpeg",
                                    0.86
                                )
                            );
                        };

                    image.src =
                        reader.result;
                };

            reader.readAsDataURL(
                file
            );
        }
    );
}

async function uploadProfilePhoto(
    event
) {
    const file =
        event.target.files?.[0];

    if (!file) {
        return;
    }

    if (
        ![
            "image/jpeg",
            "image/png",
            "image/webp"
        ].includes(
            file.type
        )
    ) {
        showToast(
            "Choose a JPG, PNG, or WebP image.",
            "warning"
        );

        return;
    }

    if (
        file.size >
        5 *
        1024 *
        1024
    ) {
        showToast(
            "Profile pictures must be 5 MB or smaller.",
            "warning"
        );

        return;
    }

    try {
        state.profile.photo =
            await resizeProfilePhoto(
                file
            );

        saveState();

        renderProfile();

        showToast(
            "Profile picture updated."
        );

    } catch {
        showToast(
            "We could not process that image.",
            "warning"
        );
    }

    event.target.value =
        "";
}

function removeProfilePhoto() {
    if (
        !state.profile.photo
    ) {
        return;
    }

    state.profile.photo =
        "";

    saveState();

    renderProfile();

    showToast(
        "Profile picture removed.",
        "warning"
    );
}

function renderAll() {
    renderDashboard();
    renderTasks();
    renderResources();
    renderProfile();
    renderProgress();
    populateSettings();
    updateTimerUI();
}

// -------------------------------------------------------------
// INTEGRITY COVERAGE
// -------------------------------------------------------------

function isReflectionOrAssessmentOpen() {
    return Boolean(
        (
            els.reflectionModal &&
            !els.reflectionModal.classList.contains(
                "hidden"
            )
        ) ||
        (
            els.assessmentModal &&
            !els.assessmentModal.classList.contains(
                "hidden"
            )
        )
    );
}

function flagReflectionIntegrityBreach(
    reason
) {
    if (
        !timer.pendingCompletion
    ) {
        return;
    }

    timer.pendingCompletion.focusViolations =
        (
            timer.pendingCompletion.focusViolations ||
            0
        ) +
        1;

    timer.pendingCompletion.checksFailed =
        (
            timer.pendingCompletion.checksFailed ||
            0
        ) +
        1;

    showToast(
        `Integrity flag: you ${reason}. This session will be logged as flagged.`,
        "error"
    );
}

function flagAndPauseActiveSession(
    reason,
    message
) {
    if (
        !timer.running ||
        timer.mode !==
        "focus" ||
        !state.settings.focusTracking
    ) {
        return;
    }

    timer.focusViolations +=
        1;

    timer.automaticallyPausedByBlur =
        true;

    pauseTimer(
        reason
    );

    updateTimerUI();

    showToast(
        message,
        "error"
    );
}

function handleVisibilityChange() {
    if (
        document.hidden
    ) {
        if (
            isReflectionOrAssessmentOpen()
        ) {
            flagReflectionIntegrityBreach(
                "left the platform during your reflection or quiz"
            );

        } else if (
            timer.running &&
            timer.mode ===
            "focus" &&
            state.settings.focusTracking
        ) {
            flagAndPauseActiveSession(
                "Paused: left Study Companion",
                "Session paused and flagged because you left the Study Companion."
            );
        }

        flushSaveState();

        return;
    }

    if (
        timer.automaticallyPausedByBlur &&
        timer.mode ===
        "focus"
    ) {
        timer.automaticallyPausedByBlur =
            false;

        showToast(
            "You returned to the Study Companion. The session remains paused because leaving the platform was flagged.",
            "warning"
        );
    }
}

function handleWindowBlur() {
    if (
        document.hidden
    ) {
        return;
    }

    /*
     * Give the browser a moment to settle.
     * This prevents false positives for focus changes
     * that still belong to this page.
     */
    window.setTimeout(
        () => {
            if (
                document.hidden ||
                document.hasFocus()
            ) {
                return;
            }

            if (
                isReflectionOrAssessmentOpen()
            ) {
                flagReflectionIntegrityBreach(
                    "switched to another window or used split screen during your reflection or quiz"
                );

                return;
            }

            if (
                timer.running &&
                timer.mode ===
                "focus" &&
                state.settings.focusTracking
            ) {
                flagAndPauseActiveSession(
                    "Paused: Study Companion lost focus",
                    "Session paused and flagged because another window or application received focus."
                );
            }
        },
        120
    );
}

function handleFullscreenChange() {
    if (
        isReflectionOrAssessmentOpen()
    ) {
        if (
            !document.fullscreenElement
        ) {
            flagReflectionIntegrityBreach(
                "left full screen during your reflection or quiz"
            );
        }

        return;
    }

    if (
        timer.running &&
        timer.mode ===
        "focus" &&
        state.settings.focusTracking &&
        !document.fullscreenElement
    ) {
        flagAndPauseActiveSession(
            "Paused: full screen exited",
            "Session paused and flagged because full screen was exited."
        );
    }
}

function handleSessionResize() {
    if (
        !timer.running ||
        timer.mode !==
        "focus" ||
        !state.settings.focusTracking
    ) {
        return;
    }

    /*
     * A valid focus session must remain
     * in browser fullscreen.
     */
    if (
        !document.fullscreenElement
    ) {
        flagAndPauseActiveSession(
            "Paused: study window changed",
            "Session paused and flagged because the study window was resized or moved out of full screen."
        );
    }
}// -------------------------------------------------------------
// EVENTS
// -------------------------------------------------------------

function bindEvents() {
    els.navItems.forEach(
        item => {
            item.addEventListener(
                "click",
                () =>
                    navigate(
                        item.dataset.section
                    )
            );
        }
    );

    document
        .querySelectorAll(
            "[data-go-to]"
        )
        .forEach(
            button => {
                button.addEventListener(
                    "click",
                    () =>
                        navigate(
                            button.dataset.goTo
                        )
                );
            }
        );

    els.menuButton.addEventListener(
        "click",
        () =>
            els.sidebar.classList.toggle(
                "open"
            )
    );

    els.themeToggle.addEventListener(
        "click",
        () => {
            state.settings.theme =
                state.settings.theme ===
                    "dark"
                    ? "light"
                    : "dark";

            saveState();

            applyTheme();
        }
    );

    els.modeTabs.forEach(
        tab => {
            tab.addEventListener(
                "click",
                () =>
                    setTimerMode(
                        tab.dataset.mode
                    )
            );
        }
    );

    els.startPauseTimer.addEventListener(
        "click",
        toggleTimer
    );

    els.resetTimer.addEventListener(
        "click",
        resetTimer
    );

    els.skipTimer.addEventListener(
        "click",
        skipTimer
    );

    els.confirmPresence.addEventListener(
        "click",
        confirmPresence
    );

    els.sessionGoal.addEventListener(
        "input",
        () => {
            els.goalCount.textContent =
                els.sessionGoal.value.length;
        }
    );

    els.profileShortcut.addEventListener(
        "click",
        () =>
            navigate(
                "profile"
            )
    );

    els.openResourceModal.addEventListener(
        "click",
        () => {
            els.resourceForm.reset();

            updateFileDropDisplay();

            toggleResourceFields();

            openModal(
                els.resourceModal
            );
        }
    );

    els.resourceKind.addEventListener(
        "change",
        toggleResourceFields
    );

    els.resourceForm.addEventListener(
        "submit",
        saveResource
    );

    els.resourceSearch.addEventListener(
        "input",
        renderResources
    );

    els.resourceTypeFilter.addEventListener(
        "change",
        renderResources
    );

    els.closeWorkspace.addEventListener(
        "click",
        closeStudyWorkspace
    );

    if (
        els.toggleWorkspaceFullscreen
    ) {
        els.toggleWorkspaceFullscreen.addEventListener(
            "click",
            toggleWorkspaceFullscreen
        );
    }

    els.openTutorChat.addEventListener(
        "click",
        () =>
            openTutorChatFor(
                timer.activeResourceId
            )
    );

    els.tutorChatForm.addEventListener(
        "submit",
        sendTutorChatMessage
    );

    els.clearTutorChat.addEventListener(
        "click",
        resetTutorChat
    );

    if (
        els.tutorChatAttachButton &&
        els.tutorChatFileInput
    ) {
        els.tutorChatAttachButton.addEventListener(
            "click",
            () =>
                els.tutorChatFileInput.click()
        );

        els.tutorChatFileInput.addEventListener(
            "change",
            handleTutorFileSelected
        );
    }

    els.tutorChatInput.addEventListener(
        "keydown",
        event => {
            if (
                event.key ===
                "Enter" &&
                !event.shiftKey
            ) {
                event.preventDefault();

                els.tutorChatForm.requestSubmit();
            }
        }
    );

    els.profileForm.addEventListener(
        "submit",
        saveProfile
    );

    [
        els.profilePhotoButton,
        els.changeProfilePhoto
    ].forEach(
        button =>
            button.addEventListener(
                "click",
                () =>
                    els.profilePhotoInput.click()
            )
    );

    els.profilePhotoInput.addEventListener(
        "change",
        uploadProfilePhoto
    );

    els.removeProfilePhoto.addEventListener(
        "click",
        removeProfilePhoto
    );

    els.logoutButton.addEventListener(
        "click",
        logout
    );

    bindFileDropEvents();

    els.openTaskModal.addEventListener(
        "click",
        () =>
            openTaskEditor()
    );

    els.taskForm.addEventListener(
        "submit",
        saveTask
    );

    els.taskSearch.addEventListener(
        "input",
        renderTasks
    );

    els.priorityFilter.addEventListener(
        "change",
        renderTasks
    );

    document.addEventListener(
        "click",
        event => {
            const closeButton =
                event.target.closest(
                    "[data-close-modal]"
                );

            if (closeButton) {
                closeModal(
                    document.getElementById(
                        closeButton.dataset.closeModal
                    )
                );
            }

            const editButton =
                event.target.closest(
                    "[data-edit-task]"
                );

            if (editButton) {
                const task =
                    state.tasks.find(
                        item =>
                            item.id ===
                            editButton.dataset.editTask
                    );

                if (task) {
                    openTaskEditor(
                        task
                    );
                }
            }

            const deleteButton =
                event.target.closest(
                    "[data-delete-task]"
                );

            if (deleteButton) {
                deleteTask(
                    deleteButton.dataset.deleteTask
                );
            }

            const moveButton =
                event.target.closest(
                    "[data-move-task]"
                );

            if (moveButton) {
                moveTask(
                    moveButton.dataset.moveTask,
                    moveButton.dataset.nextStatus
                );
            }

            const studyTaskButton =
                event.target.closest(
                    "[data-study-task]"
                );

            if (
                studyTaskButton
            ) {
                startTaskStudy(
                    studyTaskButton.dataset.studyTask
                );
            }

            const openResourceButton =
                event.target.closest(
                    "[data-open-resource]"
                );

            if (
                openResourceButton
            ) {
                openStudyResource(
                    openResourceButton.dataset.openResource
                );
            }

            const planResourceButton =
                event.target.closest(
                    "[data-plan-resource]"
                );

            if (
                planResourceButton
            ) {
                planResourceTask(
                    planResourceButton.dataset.planResource
                );
            }

            const deleteResourceButton =
                event.target.closest(
                    "[data-delete-resource]"
                );

            if (
                deleteResourceButton
            ) {
                deleteResource(
                    deleteResourceButton.dataset.deleteResource
                );
            }

            const reflectionButton =
                event.target.closest(
                    "[data-view-reflection]"
                );

            if (
                reflectionButton
            ) {
                viewReflection(
                    reflectionButton.dataset.viewReflection
                );
            }

            const resultsButton =
                event.target.closest(
                    "[data-view-results]"
                );

            if (
                resultsButton
            ) {
                viewSessionResults(
                    resultsButton.dataset.viewResults
                );
            }
        }
    );

    document
        .querySelectorAll(
            ".modal-backdrop"
        )
        .forEach(
            backdrop => {
                backdrop.addEventListener(
                    "mousedown",
                    event => {
                        if (
                            event.target !==
                            backdrop
                        ) {
                            return;
                        }

                        if (
                            [
                                els.verificationModal,
                                els.reflectionModal
                            ].includes(
                                backdrop
                            )
                        ) {
                            return;
                        }

                        closeModal(
                            backdrop
                        );
                    }
                );
            }
        );

    els.reflectionText.addEventListener(
        "input",
        validateReflection
    );

    els.assessmentForm.addEventListener(
        "submit",
        submitAssessment
    );

    els.backToReflection.addEventListener(
        "click",
        backToReflection
    );

    [
        "paste",
        "copy",
        "cut",
        "drop"
    ].forEach(
        eventName => {
            els.reflectionText.addEventListener(
                eventName,
                event => {
                    event.preventDefault();

                    showToast(
                        "Copy and paste are disabled for session reflections.",
                        "warning"
                    );
                }
            );
        }
    );

    els.reflectionText.addEventListener(
        "contextmenu",
        event =>
            event.preventDefault()
    );

    els.saveReflection.addEventListener(
        "click",
        saveReflection
    );

    els.discardSession.addEventListener(
        "click",
        discardSession
    );

    els.clearHistory.addEventListener(
        "click",
        () => {
            if (
                !state.sessions.length
            ) {
                return;
            }

            if (
                !window.confirm(
                    "Clear all saved session history?"
                )
            ) {
                return;
            }

            state.sessions =
                [];

            saveState();

            renderAll();

            showToast(
                "Session history cleared.",
                "warning"
            );
        }
    );

    els.saveSettings.addEventListener(
        "click",
        saveSettings
    );

    els.resetAllData.addEventListener(
        "click",
        resetAllData
    );

    if (
        els.migrateToB2
    ) {
        els.migrateToB2.addEventListener(
            "click",
            migrateResourcesToB2
        );
    }

    /*
     * Focus integrity listeners.
     */
    document.addEventListener(
        "visibilitychange",
        handleVisibilityChange
    );

    document.addEventListener(
        "fullscreenchange",
        handleFullscreenChange
    );

    window.addEventListener(
        "blur",
        handleWindowBlur
    );

    window.addEventListener(
        "resize",
        handleSessionResize
    );

    window.addEventListener(
        "beforeunload",
        event => {
            if (
                timer.running &&
                timer.mode ===
                "focus"
            ) {
                event.preventDefault();

                event.returnValue =
                    "";
            }

            flushSaveState();
        }
    );

    document.addEventListener(
        "keydown",
        event => {
            if (
                event.key ===
                "Escape"
            ) {
                [
                    els.taskModal,
                    els.resourceModal,
                    els.reflectionViewModal
                ].forEach(
                    modal =>
                        closeModal(
                            modal
                        )
                );
            }

            if (
                event.code ===
                "Space" &&
                document.activeElement ===
                document.body
            ) {
                event.preventDefault();

                toggleTimer();
            }
        }
    );
}

// -------------------------------------------------------------
// APP INITIALISATION
// -------------------------------------------------------------

async function launchApp(
    user,
    signupName = ""
) {
    currentUser =
        user;

    state =
        await loadState(
            user.id
        );

    state.profile.email =
        user.email ||
        state.profile.email;

    if (signupName) {
        state.profile.name =
            signupName;

    } else if (
        user.user_metadata?.full_name
    ) {
        state.profile.name =
            user.user_metadata.full_name;
    }

    saveState();

    els.authShell.classList.add(
        "hidden"
    );

    els.appShell.classList.remove(
        "hidden"
    );

    const now =
        new Date();

    els.todayLabel.textContent =
        new Intl.DateTimeFormat(
            "en-NG",
            {
                weekday:
                    "long",

                day:
                    "numeric",

                month:
                    "long"
            }
        ).format(
            now
        );

    applyTheme();

    populateSettings();

    renderAll();

    setTimerMode(
        "focus",
        true
    );

    navigate(
        "dashboard"
    );
}

async function initialise() {
    initialiseAuth();

    bindEvents();

    const user =
        await getCurrentUser();

    if (!user) {
        els.authShell.classList.remove(
            "hidden"
        );

        els.appShell.classList.add(
            "hidden"
        );

        return;
    }

    await launchApp(
        user
    );
}

initialise();

}) ();
