import { defineConfig, mergeConfig } from "vitest/config";
import { hostPackageBaseConfig } from "../../vitest.shared";

// Package-specific overrides (none today) go in the second defineConfig().
export default mergeConfig(hostPackageBaseConfig, defineConfig({}));
