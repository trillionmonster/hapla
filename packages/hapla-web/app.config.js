const variant = process.env.APP_ENV || 'development';
const name = {
    development: "Hapla (dev)",
    preview: "Hapla (preview)",
    production: "Hapla"
}[variant];
const consoleLoggingDefault = {
    development: true,
    preview: true,
    production: false,
}[variant];

export default {
    expo: {
        name,
        slug: "hapla",
        version: "1.0.0",
        runtimeVersion: "21",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: "hapla",
        userInterfaceStyle: "automatic",
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-asset"
        ],
        experiments: {
            typedRoutes: true
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            app: {
                consoleLoggingDefault,
            }
        }
    }
};
