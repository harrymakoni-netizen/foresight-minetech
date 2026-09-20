import type { NextConfig } from "next";
const config: NextConfig = { outputFileTracingIncludes: { '/api/assistant': ['./public/replay/*.json'] } };
export default config;
