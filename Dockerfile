# syntax=docker/dockerfile:1

# ---------- web (Angular + Material) ----------
FROM node:24-trixie-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY web/ ./
RUN npx ng build --configuration production

# ---------- api (.NET 10) ----------
FROM mcr.microsoft.com/dotnet/sdk:10.0-noble AS api
WORKDIR /src
COPY src/MailLog/MailLog.csproj src/MailLog/
COPY agent/ agent/
RUN dotnet restore src/MailLog/MailLog.csproj
COPY src/ src/
RUN dotnet publish src/MailLog/MailLog.csproj -c Release -o /out /p:UseAppHost=false --no-restore

# ---------- runtime ----------
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=api /out ./
COPY --from=web /src/web/dist ./wwwroot
USER app
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_RUNNING_IN_CONTAINER=true
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["dotnet", "MailLog.dll"]
