# Simulation worker: CPU only. Build from the repository root:
#   docker build -f deploy/simulator.Dockerfile -t foresight-simulator .
FROM python:3.13-slim
# libGL/libEGL are runtime dependencies of the PySide6/VTK packages jupedsim installs.
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libegl1 libxkbcommon0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-sim.txt .
RUN pip install --no-cache-dir -r requirements-sim.txt
COPY services/__init__.py services/__init__.py
COPY services/simulator services/simulator
ENV FORESIGHT_SIMULATOR_HOST=0.0.0.0 FORESIGHT_SIMULATOR_PORT=8100 FORESIGHT_JOB_DATABASE=/data/simulator-jobs.sqlite PYTHONUNBUFFERED=1
RUN mkdir -p /data && chown nobody /data
VOLUME /data
EXPOSE 8100
USER nobody
CMD ["python", "-m", "services.simulator.server"]
