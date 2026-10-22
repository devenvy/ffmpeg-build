FROM registry.fedoraproject.org/fedora@sha256:a32cc6149ce88510a5e23ce249d42681d61758d5851c398d29a76e5c94d1ed72
RUN dnf install -y mesa-vulkan-drivers nodejs binutils && dnf clean all
