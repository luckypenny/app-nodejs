### Docker Build & Push for NodeJS GH Actions
- event trigger 
  - build/{env}/app-1
  - build/{env}/app-2
  - build/{env}/app-2 

```shell
# environment 
  - REGISTRY_HOSTNAME: ghcr.io # docker image registry url 
  - DOCKER_FILE: Dockerfile # docker build file
  - KUSTOMISE_DIRECTORY: k8s/app-nodejs # devops repo kustomize app directory 
```
## Jobs
### docker build 
- Setting Environment Variables : 환경 변수 수집 
- Docker Registry Login 
- Docker Build 

### update-build-image-tag (DevOps Build)
- 설정된 파드의 디렉토리를 찾습니다. 
- 이미지 커밋 번호를 sed로 치환합니다.  
- 키밋 및 푸쉬 합니다.