FROM node:lts-alpine

ARG BUILD_PROC_PATH
ARG APP_HOME_PATH=/app_home
ARG APP_ROOT=${APP_HOME_PATH}/${BUILD_PROC_PATH}

# ARG APP_COMMON_PATH=/${APP_ROOT_PATH}/commons
ENV TARGET_NAME_ENV=${BUILD_PROC_PATH}

# curl install
RUN apk --no-cache add curl jq httpie procps strace

# app directory 생성
RUN mkdir -p ${APP_HOME_PATH}

# Copy common files
# COPY apps/_app_path.js ${APP_HOME_PATH}/apps/
COPY commons ${APP_HOME_PATH}/commons

# copy app files to app/
COPY ${TARGET_NAME_ENV} ${APP_HOME_PATH}/${TARGET_NAME_ENV}

COPY ./package*.json ${APP_HOME_PATH}/

WORKDIR ${APP_HOME_PATH}

RUN npm install

RUN echo 'alias ll="ls -al"' >> ~/.profile
ENV ENV="/root/.profile"
ENV UV_THREADPOOL_SIZE=1
ENV DD_TRACE_DISABLED_PLUGINS='dns,express'
CMD node --v8-pool-size=4 ${TARGET_NAME_ENV}

#docker build -f docker/Dockerfile -t caster:local . --build-arg BUILD_PROC_PATH=apps/caster